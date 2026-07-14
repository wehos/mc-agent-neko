// mineDown — a SAFE sealed 1-wide descending staircase miner. The bot keeps dying/stalling
// because it never closes the armor gap (86% of deaths are unarmored), and the patch
// layers gate it out of ALL mining — so it stands down forever in food deserts. But mining a
// 1-wide staircase is SAFE even at hp10: you are always in a single-block slot no mob can reach.
// This gets the bot DOWN to the iron band, collecting ore en route, breaking the surface
// stand-down deadlock and feeding the iron->armor chain.
//
// Reuses the safety idiom proven in escapePlan: pure cellSafety() (lava/bedrock), breakBlockAt,
// and a low-level forward walk (no pathfinder — descent is a 1-block drop the bot falls into).
//
// opts: { steps=40, heading=null (auto), targetY=45 }

import { collectExposedOresDuringDescent } from './descentOreSweep.js';

// ★C311 (T-0048): WATER was missing here — only lava was guarded. mineDown dug a staircase
// straight into an aquifer at depth (y35) and the bot drowned (#112), while its siblings
// branchMine (BAD_FLUID=/lava|water/) and digDown (_WL incl. water) both stop on water.
// Water in the feet/head/floor cell, or flowing in from a side, must STOP the descent.
const FLUID = /(lava|flowing_lava|water|flowing_water)/;
const UNBREAKABLE = /(bedrock|barrier|obsidian|reinforced_deepslate)/;

// PURE: descending-staircase feet-cell sequence from start along a cardinal heading.
// Each step moves 1 on the heading axis and 1 down. Deterministic, offline-testable.
function stairCells(start, sx, sz, n) {
    const cells = [];
    let x = start.x, y = start.y, z = start.z;
    for (let i = 0; i < n; i++) { x += sx; z += sz; y -= 1; cells.push({ x, y, z }); }
    return cells;
}

// PURE: safe to dig+drop into this stair cell? reads = {feet,head,floor,fluidNear}
function stairSafety(reads) {
    if (reads.fluidNear) return { safe: false, reason: 'fluid (lava/water) near stair cell' };
    if (FLUID.test(reads.feet || '') || FLUID.test(reads.head || '') || FLUID.test(reads.floor || '')) return { safe: false, reason: 'fluid in/under stair cell' };
    if (UNBREAKABLE.test(reads.feet || '') || UNBREAKABLE.test(reads.head || '')) return { safe: false, reason: `unbreakable (${reads.feet}/${reads.head})` };
    return { safe: true, reason: 'ok' };
}

export default async function mineDown(bot, ctx, opts = {}) {
    const { log, skills, Vec3 } = ctx;
    const steps = opts.steps || 40;
    const targetY = opts.targetY != null ? opts.targetY : 45;
    const log_ = (m) => log(bot, `[mineDown] ${m}`);
    const bn = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)); } catch { return null; } };
    const nm = (b) => (b && b.name) || 'air';

    // ★P2-8b GHOST PREVENTION (2026-07-07): a fresh respawn/teleport can start this low-level
    // (no-pathfinder) descent before the client chunk cache has synced with the server — the walk
    // then physically collides with blocks the client renders as air (the ghost-block wedge, live
    // 06:01Z "walked into it as 'air'"). Let the local columns finish loading first. waitForChunksToLoad
    // is an instant no-op if they're already loaded, and self-caps at 10s; a 3s outer race keeps a
    // partial load from stalling the whole dispatch. Best-effort — never blocks the skill on failure.
    try { await Promise.race([bot.waitForChunksToLoad(), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}

    // Heading: prefer away from the nearest hostile (don't dig toward a mob); else +x.
    let sx = 1, sz = 0;
    try {
        const p = bot.entity.position;
        let nearest = null, nd = Infinity;
        for (const e of Object.values(bot.entities || {})) {
            if (e && e !== bot.entity && e.position && ctx.mc.isHostile(e)) { const d = e.position.distanceTo(p); if (d < nd) { nd = d; nearest = e; } }
        }
        if (nearest && nd < 24) { const dx = p.x - nearest.position.x, dz = p.z - nearest.position.z; if (Math.abs(dx) >= Math.abs(dz)) { sx = Math.sign(dx) || 1; sz = 0; } else { sx = 0; sz = Math.sign(dz) || 1; } }
    } catch (e) {}
    // ★fluid-abort heading rotation (2026-07-02 13:07Z: 3 dispatches from the same cell all
    // aborted on the SAME flooded stair (44,61,160) — the heading is deterministic (+x when no
    // hostile), so every retry was identical and the kind burned into cooldown. Remember
    // fluid-aborted headings near this spot (TTL 10min, bot-object state per HANDOFF red line)
    // and start with the first cardinal that hasn't failed here yet.)
    try {
        const p0 = bot.entity.position;
        bot._mineDownFluidAvoid = (bot._mineDownFluidAvoid || []).filter(a => Date.now() - a.at < 600000);
        const avoid = bot._mineDownFluidAvoid.filter(a => Math.hypot(a.x - p0.x, a.z - p0.z) < 8);
        if (avoid.some(a => a.sx === sx && a.sz === sz)) {
            const clean = [[1, 0], [0, 1], [-1, 0], [0, -1]].find(([cx, cz]) => !avoid.some(a => a.sx === cx && a.sz === cz));
            if (clean) { sx = clean[0]; sz = clean[1]; log_(`heading rotated to ${sx},${sz} — ${avoid.length} fluid/wedge-aborted heading(s) remembered near here`); }
            // ★checkpoint#25 P1-A: only REFUSE on all-flooded headings when we still NEED to staircase
            // down — already at band (y<=targetY+2) the descent heading is moot (the at-band delegate
            // below hands off to branchMine, which has its own per-cell fluid guards), so stale fluid
            // memories from earlier descents must not block lateral mining at the band.
            else if (bot.entity.position.y > targetY + 2) {
                // ★P2-8c RELOCATE-THEN-RETRY (lever #1, 2026-07-07): every cardinal near here is
                // fluid/wedge-aborted → the descent CANNOT start from this cell, and honest-failing
                // just let the kernel re-dispatch onto the SAME dead cell (the ~40-50s发呆 loop). The
                // skill's own log begged "higher layer should relocate first" but nobody did it — so do
                // it HERE: move to fresh ground (>~6b clears the per-spot heading memory, which keys on
                // hypot<8) and re-derive a clean heading, then fall through to the descent this dispatch.
                // Guarded: only proceed if we actually moved AND landed on solid, dry footing AND a clean
                // cardinal opened up; otherwise honest-fail as before (the 3-strike cooldown still backs us).
                // reviewer#1: bound relocate hopping — ≤2 relocations per rolling 3-min window, else
                // honest-fail. Without this the per-spot heading memory (hypot<8) can't catch a bot that
                // hops ≥6b each time, so it would street-walk across a bad region (the 逛街 failure family).
                let rb = bot._mdRelocateBudget;
                if (!rb || Date.now() - rb.at > 180000) rb = bot._mdRelocateBudget = { at: Date.now(), count: 0 };
                if (rb.count >= 2) { log_(`relocate budget spent (${rb.count}/2 in <3min) — honest fail, higher layer should reposition`); return { failed: true, abort: 'all headings flooded/wedged; relocate budget spent' }; }
                const before = bot.entity.position.clone();
                try { await skills.moveAway(bot, 10); } catch (e) {}
                const p2 = bot.entity.position;
                const movedB = Math.hypot(p2.x - before.x, p2.z - before.z);
                const feetB = bn(Math.floor(p2.x), Math.floor(p2.y) - 1, Math.floor(p2.z));
                const footingOk = feetB && feetB.boundingBox === 'block' && !FLUID.test(nm(feetB)) && !!bot.entity.onGround;
                const avoid2 = bot._mineDownFluidAvoid.filter(a => Date.now() - a.at < 600000 && Math.hypot(a.x - p2.x, a.z - p2.z) < 8);
                const clean2 = [[1, 0], [0, 1], [-1, 0], [0, -1]].find(([cx, cz]) => !avoid2.some(a => a.sx === cx && a.sz === cz));
                if (movedB >= 6 && footingOk && clean2) {
                    sx = clean2[0]; sz = clean2[1];
                    rb.count++; rb.at = Date.now();
                    // suppress the bed-anchor pull below for ~90s — else it immediately pathfinds us
                    // right back to the all-aborted anchor cell we just escaped and lever#1 is a no-op.
                    try { bot._mdSkipBedAnchorUntil = Date.now() + 90000; } catch (e) {}
                    log_(`relocated ${movedB.toFixed(1)}b to fresh ground @${Math.round(p2.x)},${Math.round(p2.z)} — retry descent heading=${sx},${sz} (lever#1, relocate ${rb.count}/2)`);
                } else {
                    log_(`relocate failed (moved=${movedB.toFixed(1)}b footingOk=${footingOk} cleanHeading=${!!clean2}) — honest fail, higher layer should reposition`);
                    return { failed: true, abort: 'all headings flooded/wedged; relocate failed' };
                }
            }
            else { log_('all 4 headings fluid/wedge-aborted near here — but already at band; branchMine delegate owns fluid safety laterally'); }
        }
    } catch (e) {}

    log_(`START pos=${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} hp=${Math.round(bot.health)} food=${bot.food} heading=${sx},${sz} targetY=${targetY}`);
    let dug = 0, ore = 0, abort = null, noProg = 0;

    // ★C248b mid-dive pickaxe-survival guard (root-harden — see memory resource-floor-bootstrap-kit).
    // C248 gates the DISPATCH (don't start a dive on a dying lone pick), but a pick that starts
    // healthy can still snap mid-dive (a 14-step staircase digs ~42 blocks > a worn wooden pick's
    // ~30 uses). Digging on past the snap strands a no-pick bot deeper in stone = the y66 tomb.
    // So each step: if the lone pick is about to break AND we can't craft a replacement, ABORT
    // now (still has a few uses to climb back; higher layer then surfaces for wood).
    const invCount = (re) => bot.inventory.items().filter(it => re.test(it.name || '')).reduce((s, it) => s + it.count, 0);
    // ★2026-07-05 用户令1: 地底隧道直通床区 — 床锚 10-48b 内 → 井口设在家门口, 竖井天然
    //    通家 (死亡重生即矿口, 免地表折返税)。>48b 不折返 (远征矿有自己的语境)。
    try {
        const lmB = bot._world && bot._world.landmarks && bot._world.landmarks.bed;
        if (lmB && Number.isFinite(lmB.x)) {
            const dB = Math.hypot(lmB.x - bot.entity.position.x, lmB.z - bot.entity.position.z);
            const skipBed = bot._mdSkipBedAnchorUntil && Date.now() < bot._mdSkipBedAnchorUntil;
            // reviewer#2: the pull is a near-SURFACE entrance step. dB is horizontal-only, so once the bot
            // has committed to a shaft below the bed level it would otherwise re-fire forever and yank a
            // mid-descent bot sideways/up back over the anchor. Don't pull home once we're >4b below the bed.
            const belowBed = Number.isFinite(lmB.y) && bot.entity.position.y < lmB.y - 4;
            if (skipBed) {
                // ★lever#1 exception: the anchor cell was all-headings-aborted and we relocated off it.
                // Honor that relocation (mine the fresh shaft) instead of yo-yoing back to the dead cell.
                // Narrow, logged, time-boxed override of 用户令 "隧道直通床区" — only when the anchor is undiggable.
                log_('bed-anchor pull skipped — recently relocated off an all-aborted anchor cell (lever#1); mining the fresh shaft');
            } else if (!belowBed && dB > 10 && dB <= 48) {
                log_(`bed-first entrance: 床锚 ${Math.round(dB)}b — 井口设在家 (用户令: 隧道直通床区)`);
                await Promise.race([
                    skills.goToPosition(bot, lmB.x, null, lmB.z, 6),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('bed-first-timeout')), 45000)),
                ]).catch(() => { try { bot.pathfinder.stop(); } catch (e) {} try { bot.clearControlStates(); } catch (e) {} });
            }
        }
    } catch (e) {}

    // ★2026-07-05 石镐 fodder 就地再造 (铁镐#3/#4 各 ~15min 阵亡实录: 分层守卫只会"装备
    // 现有石镐", 石镐断供后铁镐即裸奔凿石 — canFieldCraftPick 谓词遍地都是, 执行端一直缺位)。
    // 入口: 无石镐且材料齐(圆石3/棍2) → craftRecipeLocal 就地造 (自带口袋台放置+T-0079 回收)。
    try {
        const _hasStone = bot.inventory.items().some(i => i.name === 'stone_pickaxe');
        if (!_hasStone && invCount(/^cobblestone$/) >= 3 && invCount(/^stick$/) >= 2) {
            await skills.craftRecipeLocal(bot, 'stone_pickaxe', 1).catch(() => {});
            log_(`fodder-recraft: stone_pickaxe → ${bot.inventory.items().some(i => i.name === 'stone_pickaxe') ? 'OK' : 'fail'} (保铁镐不碰石)`);
        }
    } catch (e) {}
    // The predicate math now lives in the shared skills.pickRunway (one tool-durability
    // budget for the descent gate, TOOL_UPKEEP proposal, and every dig loop — the local
    // copies here were the original but drifted from modes.js's kit variant; the shared
    // canFieldCraftPick is stone-strict where the old local allowed a planks-head wooden
    // fallback — stricter aborts a step earlier, the safe direction).
    const pickAboutToBreak = () => skills.pickRunway(bot).aboutToBreak;
    const canCraftPick = () => skills.pickRunway(bot).canFieldCraftPick;

    // ★P0-1 回程预算前置门 (review-2026-07-04-distance.md: 铁镐三落三起, >18h 无铁镐).
    // 中途版 C248b 只在挖矿开始后逐步检查 — 一把 <15% 耐久的孤镐照样通过入口开挖, 断在
    // 半路 = 深处无镐 + 无替补材料的经典开局. 入口即检: 孤镐将死 + planksEq<4 (现场连
    // 木镐柄都造不出) → 直接 return false (真零进度), kernel 冷却后补给类提案
    // (REPLENISH_KIT, 并行在建) 接得上手. 有备镐或有木料的照旧放行 (中途版守卫保留).
    try {
        const picks = bot.inventory.items().filter(it => /_pickaxe$/.test(it.name || ''));
        if (picks.length === 1) {
            const it = picks[0];
            const max = it.maxDurability || 0;
            const used = (typeof it.durabilityUsed === 'number') ? it.durabilityUsed : 0;
            const leftPct = max > 0 ? (max - used) / max : 1;   // 未知耐久=不恐慌 (同 skills.pickRunway)
            const planksEq = invCount(/_planks$/) + invCount(/_log$/) * 4;
            // canFieldCraftPick 是"现场造得出替补"的精确谓词 (带台+棍+石也行) — planksEq<4 只是
            // 木料侧粗筛, 两者都不行才 yield, 免得错杀带全套材料的健康派发.
            if (leftPct < 0.15 && planksEq < 4 && !canCraftPick()) {
                log_(`NO-RETURN-BUDGET yield (pick dying, no spare, no planks) — ${it.name} ${(leftPct * 100).toFixed(0)}% left, planksEq=${planksEq}`);
                return false;
            }
        }
    } catch (e) {}

    // ★KERNEL-CONTRACT entry snapshot (return-contract audit 2026-07-02): the final return judges
    // REAL progress this dispatch against these — y actually descended, or net ore units gained.
    // Hoisted from the at-depth loop so both the loop's stall judge and the return judge read one
    // definition. Do NOT trust `dug` for this: it historically counted air no-ops. Widened with
    // coal|emerald (branchMine's set has them; the old set missed the ITEM drops of coal_ore,
    // which IS in ORE above — a coal-only productive run must not judge as zero-progress).
    const oreUnits = () => invCount(/^raw_iron$/) + invCount(/^raw_copper$/) + invCount(/^raw_gold$/)
        + invCount(/^(iron_ore|deepslate_iron_ore|gold_ore|deepslate_gold_ore|redstone|lapis_lazuli|diamond|coal|emerald)$/)
        + invCount(/_ore$/);
    const entryY = Math.round(bot.entity.position.y);
    const oreUnitsAtEntry = oreUnits();

    // ★2026-07-08 到层背包满就地清理 (钻石"够不到"根因 4, 见 [[diamond-never-reached-blocker-stack]]):
    //   实录 bot 抵 targetY 后 'pack full (free=1) — stop at-depth mining' ×4 + 'diamondBank: no chest
    //   available' → 到了矿层却因满包不挖。像真玩家那样丢弃【过量低值填料】腾格续挖: 保留足量圆石/深板岩
    //   作封壁料 (mineDiamonds sealLevel/tunnelAside 要用), 矿石(raw_*/煤/钻/青金/红石/铁/金)永不丢。
    //   bounded (每类只丢超储备部分)、不 throw、腾出 >2 空格即早停。
    const _DECLUTTER_KEEP = { cobblestone: 128, cobbled_deepslate: 64, dirt: 16 };
    const _DECLUTTER_JUNK = ['cobblestone', 'cobbled_deepslate', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'dirt', 'gravel', 'netherrack'];
    const declutterAtDepth = async () => {
        let tossed = 0;
        for (const name of _DECLUTTER_JUNK) {
            try {
                const items = bot.inventory.items().filter(it => it.name === name);
                const have = items.reduce((s, it) => s + it.count, 0);
                let surplus = have - (_DECLUTTER_KEEP[name] || 0);
                if (surplus <= 0) continue;
                for (const it of items) {
                    if (surplus <= 0) break;
                    const n = Math.min(it.count, surplus);
                    try { await bot.toss(it.type, null, n); tossed += n; surplus -= n; } catch (e) {}
                    await new Promise(r => setTimeout(r, 80));
                }
                let f = 0; try { f = bot.inventory.emptySlotCount(); } catch (e) {}
                if (f > 2) break;
            } catch (e) {}
        }
        return tossed;
    };

    // ★checkpoint#25 P1-A AT-BAND DELEGATE (06:53:58-06:54:03 实录: bot 首次抵达 y=12 钻石带后,
    // 三次 mineDown 派发全部 {endY:12, dug:0, abort:null, failed:true} — 起点已在目标层, mineDown
    // 是"只下降"的技能, 下降 0 被 return-contract 判败 → 3 振 → DUSK_MINE_NIGHT 冷却在钻石层
    // 正上方 → bot 上浮放弃 → 钻石 0)。已在带内 (y <= targetY+2) 时正确动作不是"再下降", 而是
    // 转入 branchMine 支线采矿 — "mine through the night" 的本意。branchMine(bot,ctx,length,targetY)
    // 自带 lava/water/断镐/低食守卫 + C305 反 x-ray 可达门 + 自己的净进度返回契约 (真进度 truthy /
    // 零进度 false), 这里按原契约透传其返回: 有进展 → kernel 保持 commitment 再派 (下一派仍 at-band
    // → 再 branchMine, 即整夜带内轮采); 零进展 → 诚实 failed:true 进冷却 (是"没挖到"的真败, 不再是
    // "没下降"的假败)。branchMine 不可用/抛错 → 退而求其次: 本轮净矿增益或实际下降 → truthy,
    // 纯零进展仍 failed:true (诚实)。entry snapshot (entryY/oreUnitsAtEntry) 语义未破坏 — fallback
    // 判据仍读它; abort 语义未破坏 — 委派路径 abort=null (无楼梯步, 无 abort 源)。
    if (bot.entity.position.y <= targetY + 2) {
        log_(`at-band start (y=${entryY} <= targetY+2=${targetY + 2}) — delegating to branchMine (lateral ore mining), not judging by descent`);
        let bmOk = null;   // true/false = branchMine's own contract verdict; null = unavailable/threw → local fallback judge
        if (typeof skills.customSkill === 'function') {
            try { bmOk = !!(await skills.customSkill(bot, 'branchMine', 24, targetY)); }
            catch (e) { bmOk = null; log_(`branchMine threw: ${e && e.message || e} — falling back to local progress judge`); }
        } else {
            log_('skills.customSkill unavailable — falling back to local progress judge');
        }
        let inv = {}; try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
        const r = { endY: Math.round(bot.entity.position.y), dug, oreVeins: ore, hp: Math.round(bot.health), food: bot.food,
                    abort, raw_iron: inv.raw_iron || 0, iron_ore: 0, atBand: true, delegated: 'branchMine', bmReturn: bmOk };
        // Fallback judge mirrors the file's KERNEL-CONTRACT: real ore units gained or real descent.
        // (In the delegate path mineDown's own dug/ore stay 0 — branchMine digs internally — so the
        // observable local progress is picked-up ore units / y actually descended.)
        const localProgress = (entryY - r.endY) >= 1 || oreUnits() > oreUnitsAtEntry;
        const progressed = bmOk === null ? localProgress : bmOk;
        if (!progressed) r.failed = true;
        log_(`DONE ${JSON.stringify(r)} (at-band delegate: bm=${bmOk} localProgress=${localProgress})`);
        return r;
    }

    // ★P2-8 幽灵格楔死恢复 (2026-07-04 05:23Z 实录 @123,57,134 heading=1,0: DIAG 显示前方
    // (124,56-58,134) 全是 air、breakResults 全 false, 但 afterWalk 每步只挪 dx=0.04 —— 客户端
    // 视界里是空气的格子在服务器端是实心 (ghost block/视界不同步), 低层 walk 物理撞墙.
    // 旧逻辑 'no descent — wedged 2 steps' 诚实 fail → 冷却 → 重派同格同 heading 再楔, 永动).
    // 恢复链: ①重读撞墙格 (bot.world + blockAt), 实为实心 → 补挖 (ghost 已刷新) 同向重试;
    // ②仍读 air → 记入技能级黑名单 bot._mdWedgeBlacklist (TTL 10min), 以后不再朝该列走;
    // ③heading 记忆从 fluid 扩到 wedge (推进 bot._mineDownFluidAvoid) + 垂直于 heading 侧移
    // 2-4 格后换未被记忆拒绝的 heading 重试 (每派发限 2 次); ④同点 (3b 内, 跨派发记忆) 第 3
    // 次楔死 → moveAway 8b 后诚实 fail (冷却 + 释放承诺, 让别的提案在新位置接手).
    let wedgeRecoveries = 0;
    let wedgeFinal = false;
    const wedgeSidestep = async () => {
        for (const [px, pz] of [[-sz, sx], [sz, -sx]]) {   // 垂直于当前 heading 的两个方向
            const start = bot.entity.position.clone();
            let blockedDir = false;
            for (let k = 0; k < 3 && !blockedDir; k++) {
                const c0 = bot.entity.position;
                const cyf = Math.floor(c0.y);
                const tx = Math.floor(c0.x) + px, tz = Math.floor(c0.z) + pz;
                const feetB = bn(tx, cyf, tz), headB = bn(tx, cyf + 1, tz), floorB = bn(tx, cyf - 1, tz);
                // 侧移目标列安全: 无流体、脚下有实心支撑 (不为逃楔死掉进洞/水)
                if (FLUID.test(nm(feetB)) || FLUID.test(nm(headB)) || FLUID.test(nm(floorB))) break;
                if (/^(air|cave_air|void_air)$/.test(nm(floorB))) break;
                // 实心格先挖开 (UNBREAKABLE 则此向放弃)
                for (const [bx, by, bz] of [[tx, cyf + 1, tz], [tx, cyf, tz]]) {
                    const b = bn(bx, by, bz);
                    if (b && b.boundingBox === 'block') {
                        if (UNBREAKABLE.test(b.name || '')) { blockedDir = true; break; }
                        try { await skills.breakBlockAt(bot, bx, by, bz); } catch (e) {}
                    }
                }
                if (blockedDir) break;
                try {
                    await bot.lookAt(new Vec3(tx + 0.5, cyf + 0.5, tz + 0.5), true);
                    bot.setControlState('forward', true);
                    const t0 = Date.now();
                    while (Date.now() - t0 < 1500) { const pp = bot.entity.position; if (Math.hypot(pp.x - (tx + 0.5), pp.z - (tz + 0.5)) < 0.45) break; await new Promise(r => setTimeout(r, 100)); }
                } finally { try { bot.setControlState('forward', false); } catch (e) {} }
                const adv = Math.hypot(bot.entity.position.x - c0.x, bot.entity.position.z - c0.z);
                if (adv < 0.5) break;   // 这向也撞墙 (可能又是幽灵格) → 试反向
                if (Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) >= 2) break;   // 已侧移 2+ 格, 够了
            }
            const total = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
            if (total >= 1.5) { log_(`wedge sidestep moved ${total.toFixed(1)}b perp=${px},${pz}`); return true; }
        }
        return false;
    };
    // ★P2-8b ACTIVE GHOST-BUSTER (2026-07-07): the ORIGINAL recovery ① below re-reads the forward
    // column via bot.world.getBlock / bot.blockAt — but those read the SAME client chunk cache the
    // walk just wedged against, so a client-air/server-solid ghost re-reads as 'air' forever, ①
    // never fires, and we burn the heading straight into the blacklist (live 05:53Z & 06:01Z: every
    // dispatch aborted, GO_UNDERGROUND/DUSK_MINE_NIGHT into 5-min cooldown, bot发呆 in the trench).
    // Passive re-reads can't detect a desync — only INTERACTION forces the server to resend truth.
    // So: (a) back off ~0.5b to physically unwedge AND regain line-of-sight down-forward (a jammed
    // 1-wide body can't aim at the step it must break); guarded to only reverse onto a safe standing
    // cell (solid floor, open feet/head, no fluid) so we never back off a ledge or into water/lava.
    // (b) let ~250ms of block_change corrections land. (c) dig each forward cell — tool-aware
    // breakBlockAt for cells the client shows solid; a RAW bot.dig for cells it shows 'air' (breakBlockAt
    // refuses air, but a raw dig makes the server break the true ghost block and emit the corrective
    // update). Returns count of confirmed solid breaks. Bounded, best-effort, never throws.
    const forceUnghost = async (fx, cy, fz) => {
        if (bot.interrupt_code) return 0;   // ★yield fast to a supervisor cancel — don't hold the body in recovery
        try {
            const p0 = bot.entity.position;
            const bx = Math.floor(p0.x) - sx, bz = Math.floor(p0.z) - sz, by = Math.floor(p0.y);
            const bFloor = bn(bx, by - 1, bz), bFeet = bn(bx, by, bz), bHead = bn(bx, by + 1, bz);
            const openCell = (b) => !b || /^(air|cave_air|void_air)$/.test(nm(b));
            if (bFloor && bFloor.boundingBox === 'block' && !FLUID.test(nm(bFloor)) && openCell(bFeet) && openCell(bHead)) {
                await bot.lookAt(new Vec3(bx + 0.5, by + 0.5, bz + 0.5), true);
                bot.setControlState('back', true);
                const t0 = Date.now();
                while (Date.now() - t0 < 600 && Math.hypot(bot.entity.position.x - p0.x, bot.entity.position.z - p0.z) < 0.5) await new Promise(r => setTimeout(r, 60));
                try { bot.setControlState('back', false); } catch (e) {}
            }
        } catch (e) { try { bot.setControlState('back', false); } catch (e2) {} }
        await new Promise(r => setTimeout(r, 250));   // settle: let the server's block_change corrections apply
        let cleared = 0;
        for (const dy of [1, 0, -1]) {
            if (bot.interrupt_code) break;
            const b = bn(fx, cy + dy, fz);
            if (!b || FLUID.test(nm(b)) || UNBREAKABLE.test(nm(b))) continue;
            try { await bot.lookAt(new Vec3(fx + 0.5, cy + dy + 0.5, fz + 0.5), true); } catch (e) {}
            if (b.boundingBox === 'block') {
                try { if ((await skills.breakBlockAt(bot, fx, cy + dy, fz)) === true) cleared++; } catch (e) {}
            } else {
                // client shows air but the body is wedged here → dig the ghost the server still has.
                // The dig resolves only on a real blockUpdate; if the cell is truly air on both sides it
                // never resolves, so the 2s race abandons it — stopDigging() then clears the leaked
                // targetDigBlock / swingInterval / blockUpdate listener so it can't fight the next walk.
                try { const dp = bot.dig(b, true); dp.catch(() => {}); await Promise.race([dp, new Promise(r => setTimeout(r, 2000))]); }
                catch (e) {}
                finally { try { bot.stopDigging(); } catch (e) {} }
            }
        }
        return cleared;
    };
    const wedgeRecover = async (fx, cy, fz) => {
        const p = bot.entity.position;
        // ④ 同点第 3 次楔死 (跨派发记忆, TTL 10min) → moveAway 8b + 诚实 fail
        try {
            bot._mdWedgeSpots = (bot._mdWedgeSpots || []).filter(s => Date.now() - s.at < 600000);
            let spot = bot._mdWedgeSpots.find(s => Math.hypot(s.x - p.x, s.z - p.z) < 3);
            if (spot) { spot.count++; spot.at = Date.now(); } else { spot = { x: p.x, z: p.z, count: 1, at: Date.now() }; bot._mdWedgeSpots.push(spot); }
            if (spot.count >= 3) {
                log_(`wedge x${spot.count} at same spot ${Math.round(p.x)},${Math.round(p.z)} — moveAway 8b + honest fail (cooldown, other proposals take over)`);
                try { await skills.moveAway(bot, 8); } catch (e) {}
                return 'wedge-final';
            }
        } catch (e) {}
        // ⓪ ★P2-8b: force a real server re-sync BEFORE the passive re-read/blacklist below. After it,
        // re-read the forward step — the raw air-dig + settle may have opened it even when breakBlockAt
        // reported nothing (server-solid ghost cleared via the corrective block_change). Counts against
        // the same 2/dispatch budget as the sidestep so it can never loop unbounded.
        if (wedgeRecoveries < 2) {
            const cleared = await forceUnghost(fx, cy, fz);
            const f2 = bn(fx, cy - 1, fz), h2 = bn(fx, cy, fz);
            // truly-empty only: a slab/stairs/snow_layer (boundingBox!=='block') still physically wedges a
            // 1.8-tall body, so DON'T count it as open — else a non-ghost wedge burns both budgets re-walking it.
            const open2 = (b2) => !b2 || /^(air|cave_air|void_air)$/.test(nm(b2));
            if (cleared > 0 || (open2(f2) && open2(h2))) {
                wedgeRecoveries++;
                try { bot._mdWedgeBlacklist = (bot._mdWedgeBlacklist || []).filter(e2 => !(e2.x === fx && e2.z === fz && Math.abs(e2.y - cy) <= 3)); } catch (e) {}
                log_(`ghost-buster: resync cleared=${cleared} fwdOpen=${open2(f2) && open2(h2)} — retry same heading (recovery ${wedgeRecoveries}/2)`);
                return 'retry';
            }
        }
        // ① 撞墙格重查询: 客户端说 air 但物理撞墙 → bot.world/blockAt 重读, 实为实心 = ghost 已刷新, 补挖后同向重试
        let ghostDug = 0;
        for (const dy of [1, 0, -1]) {
            let b = null;
            try { b = (bot.world && typeof bot.world.getBlock === 'function') ? bot.world.getBlock(new Vec3(fx, cy + dy, fz)) : null; } catch (e) {}
            if (!b) b = bn(fx, cy + dy, fz);
            if (b && b.boundingBox === 'block' && !FLUID.test(b.name || '') && !UNBREAKABLE.test(b.name || '')) {
                log_(`wedge re-dig: re-read (${fx},${cy + dy},${fz})=${b.name} (walked into it as 'air') — digging the ghost`);
                try { const r = await skills.breakBlockAt(bot, fx, cy + dy, fz); if (r === true) ghostDug++; } catch (e) {}
            }
        }
        if (ghostDug > 0) {
            // 补挖成功 = 该列已打通, 摘除旧黑名单条目, 否则 retry 同向下一步立刻撞自己的黑名单白烧 sidestep 预算
            try { bot._mdWedgeBlacklist = (bot._mdWedgeBlacklist || []).filter(e2 => !(e2.x === fx && e2.z === fz && Math.abs(e2.y - cy) <= 3)); } catch (e) {}
            log_(`wedge re-dig cleared ${ghostDug} ghost block(s) — blacklist entry removed, retry same heading`);
            return 'retry';
        }
        // ② 重读仍全 air → 从这里破不掉的服务器端幽灵列, 记入黑名单 (TTL 10min)
        try {
            bot._mdWedgeBlacklist = (bot._mdWedgeBlacklist || []).filter(e2 => Date.now() - e2.at < 600000);
            if (!bot._mdWedgeBlacklist.some(e2 => e2.x === fx && e2.z === fz && Math.abs(e2.y - cy) <= 2)) {
                bot._mdWedgeBlacklist.push({ x: fx, y: cy, z: fz, at: Date.now() });
            }
            log_(`wedge-blacklist (${fx},${cy},${fz}) — reads air but body can't enter (ghost/desync), TTL 10min, entries=${bot._mdWedgeBlacklist.length}`);
        } catch (e) {}
        // ③ heading 记忆扩到 wedge (原来只 fluid 换向) + 强制侧移换向重试
        try { (bot._mineDownFluidAvoid = bot._mineDownFluidAvoid || []).push({ x: p.x, z: p.z, sx, sz, at: Date.now(), why: 'wedge' }); } catch (e) {}
        if (wedgeRecoveries >= 2) { log_('wedge sidestep budget spent (2/dispatch) — honest fail'); return 'no-sidestep-budget'; }
        wedgeRecoveries++;
        if (!(await wedgeSidestep())) { log_('wedge sidestep failed (both perpendicular dirs blocked) — honest fail'); return 'sidestep-blocked'; }
        try {
            const p1 = bot.entity.position;
            const avoid = (bot._mineDownFluidAvoid || []).filter(a => Date.now() - a.at < 600000 && Math.hypot(a.x - p1.x, a.z - p1.z) < 8);
            const clean = [[1, 0], [0, 1], [-1, 0], [0, -1]].find(([cx2, cz2]) => !avoid.some(a => a.sx === cx2 && a.sz === cz2));
            if (clean) { sx = clean[0]; sz = clean[1]; }
            else { sx = -sx; sz = -sz; }   // 四向都有记忆 → 至少调头, 别再撞同一列
            log_(`wedge sidestep ok — retry with heading=${sx},${sz} (recovery ${wedgeRecoveries}/2)`);
        } catch (e) {}
        return 'retry';
    };

    // ★DESCEND-TOLERANCE (worker-frozen 0701, T-0110): branch-mine once we're CLOSE to targetY, not only
    // at the exact depth. Live depth-churn: bot pinned @48,17 (targetY=14) — it could not descend the last
    // ~3 blocks (staircase 'no descent — wedged': digs the stair but the step-down walk fails), so cy(17)
    // stayed > targetY(14) forever → it NEVER fell through to branchMine → mineDown returned 'no descent'
    // every ~1.5s, kernelDriver re-dispatched, and the depth-gate (rightly) blocked the surface-migrate
    // escape → the bot froze at the iron band mining nothing until a 25min watchdog restart. y14-20 is all
    // prime iron band, so branch-mining at y≈17 is fully productive for the iron goal (diamonds get their
    // own mineDiamonds@y-11). Tolerance = 6 blocks above targetY.
    const DESCEND_TOLERANCE = 6;
    // ★2026-07-09 用户令 "以怪为基准做 hazard 感知, 不用管空腔; 只有怪在附近才特别注意": 台阶是双向敞开
    //   的走廊 — 挖进空洞/黑腔无所谓(怪不在就照挖), 但挖进【有活怪】的洞就是给怪修上行高速。故下潜途中
    //   逐步复查: HOSTILE_STEER_R 内有敌对怪且当前 heading 正朝它挖(或怪贴到点前) → 把楼梯拐向背离怪的
    //   基点(复用 START 的 away-from-hostile 推导 + fluid/wedge 换向记忆, 不撞已知流体/楔死列)。无怪 →
    //   一律不动, 照常直挖。贴到臂展(<4b)来不及拐的兜底 yield 仍在循环体里(交给 self_defense 反射)。
    const HOSTILE_STEER_R = 10;
    const steerFromHostile = () => {
        try {
            const p = bot.entity.position;
            let best = null, bd = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (!(e && e !== bot.entity && e.position && ctx.mc.isHostile(e))) continue;
                const d = e.position.distanceTo(p);
                if (d < bd) { bd = d; best = e; }
            }
            if (!best || bd > HOSTILE_STEER_R) return;
            const dx = p.x - best.position.x, dz = p.z - best.position.z;   // bot − mob (points AWAY from mob)
            const toward = (sx * -dx + sz * -dz) > 0;                        // heading · (mob − bot) > 0 = 正朝怪挖
            if (!toward && bd >= 5) return;                                  // 没朝怪挖且非点前 → 台阶保持不动
            let ax, az;                                                      // away-heading = 背离怪的主轴 (镜像 START)
            if (Math.abs(dx) >= Math.abs(dz)) { ax = Math.sign(dx) || 1; az = 0; } else { ax = 0; az = Math.sign(dz) || 1; }
            let cand = [ax, az];
            const avoid = (bot._mineDownFluidAvoid || []).filter(a => Date.now() - a.at < 600000 && Math.hypot(a.x - p.x, a.z - p.z) < 8);
            const blocked = ([cx2, cz2]) => avoid.some(a => a.sx === cx2 && a.sz === cz2);
            if (blocked(cand)) {   // away-heading 撞已知流体/楔死记忆 → 退而取任一"非朝怪"的干净基点
                const alt = [[1, 0], [0, 1], [-1, 0], [0, -1]].filter(([cx2, cz2]) => (cx2 * -dx + cz2 * -dz) <= 0 && !blocked([cx2, cz2]));
                if (!alt.length) return;                                     // 没有干净的背怪方向 → 交给 4b bail / 流体逻辑收尾
                cand = alt[0];
            }
            if (cand[0] === sx && cand[1] === sz) return;                    // 已经就是背怪基点
            sx = cand[0]; sz = cand[1];
            log_(`hostile-steer: ${best.name || 'mob'} @${bd.toFixed(1)}b — 拐向背离怪 heading=${sx},${sz} (以怪为基准, 不把台阶挖进怪堆)`);
        } catch (e) {}
    };
    for (let i = 0; i < steps; i++) {
        const cur = bot.entity.position;
        const cy = Math.round(cur.y);
        if (cy <= targetY + DESCEND_TOLERANCE) {
            // ★AT-DEPTH NO-OP FREEZE FIX (live y12 pin 450s+): mineDown ONLY descends, so once it reaches
            //   targetY it returns instantly and the proposer (GO_UNDERGROUND/DUSK_MINE_NIGHT) re-dispatches
            //   it → no-op every ~1.5s → the bot freezes at the bottom of the iron band having mined NO ore
            //   (live: y12, coal but 0 raw_iron). Fall through to branchMine — a horizontal ore tunnel
            //   (its own lava/water guards) — so the bot actually MINES iron/diamond at the band.
            // ★T-0092 AT-DEPTH BRANCH LOOP: a SINGLE branchMine(24) then return wasn't enough — the
            //   proposer re-dispatched, branchMine re-tunnelled the same dead-end, and the bot空转 at
            //   the band底. Instead LOOP branchMine here with a NET-PROGRESS judge: keep tunnelling for
            //   ore until either (a) no new ore came in over the last 2 rounds (this seam is mined out →
            //   return so a fresh dispatch starts a new heading/depth), (b) the pack is full (go bank),
            //   or (c) the pick is about to snap with no recraft (don't strand deep). This makes
            //   descend-then-MINE-OUT the productive unit instead of descend-then-touch-and-leave.
            // (oreUnits hoisted to function entry — return-contract audit 2026-07-02.)
            let lastUnits = oreUnits(), stallRounds = 0, rounds = 0;
            log_(`reached targetY=${targetY} at step ${i} — branch-mining loop for ore (oreUnits=${lastUnits})`);
            while (rounds++ < 8) {
                if (bot.interrupt_code) { abort = 'interrupted at-depth branch loop'; break; }
                // pack full → 先就地清理过量填料腾格续挖 (根因 4); 清完仍满才停交上层 bank。
                let free = 36; try { free = bot.inventory.emptySlotCount(); } catch (e) {}
                if (free <= 1) {
                    let freed = 0; try { freed = await declutterAtDepth(); } catch (e) {}
                    let free2 = free; try { free2 = bot.inventory.emptySlotCount(); } catch (e) {}
                    if (free2 <= 1) { log_(`pack full (free=${free2}) after declutter — stop at-depth mining (bank)`); break; }
                    log_(`at-depth declutter freed slots (free ${free}→${free2}, tossed ${freed} junk) — keep mining`);
                }
                // pick guard: about to break + can't recraft → return before stranding deep.
                if (pickAboutToBreak() && !canCraftPick()) { log_('pick about to break + no recraft — stop at-depth mining'); break; }
                try { await skills.customSkill(bot, 'branchMine', 24); } catch (e) { log_(`branchMine threw: ${e && e.message || e}`); break; }
                const now = oreUnits();
                if (now > lastUnits) { stallRounds = 0; lastUnits = now; }
                else { stallRounds++; if (stallRounds >= 2) { log_(`no new ore over ${stallRounds} rounds (oreUnits=${now}) — seam mined out, return for fresh dispatch`); break; } }
            }
            break;
        }
        // ★以怪为基准: 先尝试把这一步的 heading 拐离近怪 (10b 内且正朝怪挖) — 提前避, 别等贴脸。
        steerFromHostile();
        // bail to survival if an actionable hostile got close (shouldn't in a sealed stair, but guard)
        try {
            const close = Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && ctx.mc.isHostile(e) && e.position.distanceTo(cur) < 4);
            if (close) { abort = 'hostile within 4 — yield to survival'; break; }
        } catch (e) {}
        // ★C248b: stop before the only pick snaps with no replacement → don't strand deeper.
        if (pickAboutToBreak() && !canCraftPick()) { abort = `pick about to break + no replacement (planks=${invCount(/_planks$/)} logs=${invCount(/_log$/)} cobble=${invCount(/^(cobblestone|cobbled_deepslate)$/)} stick=${invCount(/^stick$/)}) — stop before stranding`; break; }

        // ★ROOT-CAUSE FIX (-22,82,10 live pin): block cells use floor(), NOT round(). At
        // x=-22.30 the bot is physically in cell floor=-23, but round=-22 → mineDown dug the
        // forward staircase one cell off from where the bot actually stood, so the bot wedged
        // against the undug side wall and never advanced (live evidence: 40 steps, dug=93, pos
        // pinned -22,82,10, walk "moved dx=0", and agent.log spamming "Skipping block ...because
        // it is air" — it kept re-digging an already-empty column 1 cell away from the body).
        // round≠floor whenever frac>0.5 or coord<0 — exactly this negative-coord food-desert pocket.
        const cx = Math.floor(cur.x), cz = Math.floor(cur.z);
        const fx = cx + sx, fz = cz + sz;                  // forward column
        // ★P2-8 黑名单前进列: 这一列此前楔死过 (客户端 air/服务器实心) → 不再朝它走, 直接进恢复链换向
        try {
            bot._mdWedgeBlacklist = (bot._mdWedgeBlacklist || []).filter(e2 => Date.now() - e2.at < 600000);
            if (bot._mdWedgeBlacklist.some(e2 => e2.x === fx && e2.z === fz && Math.abs(e2.y - cy) <= 3)) {
                log_(`wedge-blacklist hit at forward (${fx},${cy},${fz}) — recover without re-wedging`);
                const handled = await wedgeRecover(fx, cy, fz);
                if (handled === 'retry') { noProg = 0; continue; }
                if (handled === 'wedge-final') wedgeFinal = true;
                abort = `forward column blacklisted (ghost) at ${fx},${cy},${fz} (${handled}); yield`;
                break;
            }
        } catch (e) {}
        // DESCEND-forward: the new standing cell is ONE block down-and-forward. New feet at
        // (fx,cy-1,fz), new head at (fx,cy,fz), plus (fx,cy+1,fz) headroom. The support under
        // the new feet is (fx,cy-2,fz) and MUST stay solid or the bot free-falls.
        const newFeet = bn(fx, cy - 1, fz), newHead = bn(fx, cy, fz), clear = bn(fx, cy + 1, fz);
        const support = bn(fx, cy - 2, fz);
        // ★C311 (T-0048): was lava-only; now lava+water — an aquifer floods the stair from the
        // SIDE (not just the cell we break), the recurring deep drowning (#112). Same ring, both fluids.
        let fluidNear = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, -2, 0]]) {
            if (/lava|water/.test(nm(bn(fx + dx, cy - 1 + dy, fz + dz)))) { fluidNear = true; break; }
        }
        const safe = stairSafety({ feet: nm(newFeet), head: nm(newHead), floor: nm(support), fluidNear });
        if (!safe.safe) {
            abort = `unsafe at ${fx},${cy - 1},${fz}: ${safe.reason}`;
            // feed the heading-rotation memory (see START) so the next dispatch tries a different way
            if (/fluid/.test(safe.reason || '')) {
                try { (bot._mineDownFluidAvoid = bot._mineDownFluidAvoid || []).push({ x: bot.entity.position.x, z: bot.entity.position.z, sx, sz, at: Date.now() }); } catch (e) {}
            }
            break;
        }
        // No solid support under the new feet (cliff/cave) => don't blind-drop; stop.
        if (/^(air|cave_air|void_air|water|flowing_water)$/.test(nm(support))) { abort = `no floor support under ${fx},${cy - 2},${fz} (${nm(support)}) — stop, don't free-fall`; break; }

        if (i < 3) log_(`DIAG step${i} cur=${cur.x.toFixed(2)},${cur.y.toFixed(2)},${cur.z.toFixed(2)} cx,cy,cz=${cx},${cy},${cz} fwd=${fx},${fz} sx,sz=${sx},${sz} blocks: newFeet(${fx},${cy - 1},${fz})=${nm(newFeet)} newHead(${fx},${cy},${fz})=${nm(newHead)} clear(${fx},${cy + 1},${fz})=${nm(clear)} support(${fx},${cy - 2},${fz})=${nm(support)}`);
        try {
            const r1 = await skills.breakBlockAt(bot, fx, cy + 1, fz);   // headroom (old head level)
            const r2 = await skills.breakBlockAt(bot, fx, cy, fz);       // new head
            const r3 = await skills.breakBlockAt(bot, fx, cy - 1, fz);   // new feet (one down-forward)
            if (i < 3) log_(`DIAG step${i} breakResults head+1=${r1} head=${r2} feet=${r3}`);
            // ★return-contract audit 2026-07-02: was `dug += 3` UNCONDITIONALLY — a re-dispatched
            // wedged bot no-op'ing on already-air cells returned {dug:6} "progress" with zero world
            // change (the -22,82,10 pin family). breakBlockAt returns strict true only when a block
            // was actually removed, so count only those.
            dug += [r1, r2, r3].filter(v => v === true).length;
        } catch (e) { abort = `dig threw: ${e && e.message || e}`; break; }

        // Walk forward; the bot falls 1 block into the cleared step. Low-level (no pathfinder).
        try {
            await bot.lookAt(new Vec3(fx + 0.5, cy - 0.5, fz + 0.5), true);
            bot.setControlState('forward', true);
            const t0 = Date.now();
            while (Date.now() - t0 < 2500) { const p = bot.entity.position; if (Math.hypot(p.x - (fx + 0.5), p.z - (fz + 0.5)) < 0.4) break; await new Promise(r => setTimeout(r, 100)); }
        } finally { try { bot.setControlState('forward', false); } catch (e) {} }

        const np = bot.entity.position;
        const stepDescended = (cur.y - np.y) > 0.5;
        const stepMovedHoriz = Math.hypot(np.x - cur.x, np.z - cur.z) > 0.5;
        if (stepDescended || stepMovedHoriz) {
            try {
                const swept = await collectExposedOresDuringDescent(bot, ctx);
                if (swept.mined > 0) {
                    ore += swept.mined;
                    log_(`顺手采矿 ${swept.family} x${swept.mined} (${swept.elapsedMs}ms)`);
                }
            } catch (e) { log_(`顺手采矿跳过: ${e && e.message || e}`); }
        }
        if (i < 3) log_(`DIAG step${i} afterWalk pos=${np.x.toFixed(2)},${np.y.toFixed(2)},${np.z.toFixed(2)} (moved dx=${(np.x - cur.x).toFixed(2)} dy=${(np.y - cur.y).toFixed(2)} dz=${(np.z - cur.z).toFixed(2)})`);
        if (i % 5 === 0) log_(`step ${i + 1} pos=${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} dug=${dug} ore=${ore} hp=${Math.round(bot.health)} food=${bot.food}`);
        // ★FIX no-advance guard: the OLD test compared np.x to the cell INDEX with a <0.3 band,
        // which a stable .30 fractional offset slips through forever (live: 40 steps, 0 descent,
        // guard never fired). Judge ACTUAL per-step progress instead: a real step drops y by ~1
        // OR moves >0.5 horizontally. Neither = wedged this step. Abort after 2 wedged steps so a
        // genuinely-stuck mineDown returns an honest "no descent" fast (→ higher layer can relocate)
        // instead of grinding 120 no-op digs in place.
        if (!stepDescended && !stepMovedHoriz) noProg++; else noProg = 0;
        if (noProg >= 2) {
            // ★P2-8: 楔死不再立刻放弃 — 先走幽灵格恢复链 (re-dig/blacklist/sidestep 换向), 只有
            // 恢复链也无路 (同点 x3 / 侧移预算尽 / 两向全堵) 才诚实 fail 进冷却.
            const handled = await wedgeRecover(fx, cy, fz);
            if (handled === 'retry') { noProg = 0; continue; }
            if (handled === 'wedge-final') wedgeFinal = true;
            abort = `no descent — wedged ${noProg} steps at ${Math.round(np.x)},${Math.round(np.y)},${Math.round(np.z)} (${handled}); yield`;
            break;
        }
    }

    let inv = {}; try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
    const r = { endY: Math.round(bot.entity.position.y), dug, oreVeins: ore, hp: Math.round(bot.health), food: bot.food, abort, raw_iron: inv.raw_iron || 0, iron_ore: 0, wedgeRecoveries, wedgeFinal };
    // ★KERNEL-CONTRACT FIX (return-contract audit 2026-07-02): this is the file's ONLY return and
    // it was always truthy with no failed key, so every ZERO-PROGRESS exit reset the kernel's
    // dispatch-failure counter (kernel.js failed-sniff = threw / ===false / ok===false /
    // failed===true) and the committed kind re-dispatched the identical abort every ~2s forever:
    // step-0 aborts (fluid near stair cell / no floor support / pick-runway) against static world
    // blocks on a deterministic +x heading, at-depth mined-out-seam exits, and wedged air-no-op
    // re-digs. GO_UNDERGROUND stays committed until iron pick/buffer, DUSK_MINE_NIGHT ALL NIGHT —
    // unbreakable hot livelock, the 3-strike/5-min cooldown could never trip. Judge REAL progress
    // this dispatch against the entry snapshot (descended >=1 block OR net ore units gained);
    // zero progress marks failed:true so the cooldown engages and the commitment is released.
    // Shape keeps all fields (kernel is the only consumer; no other caller reads this object).
    // ★P2-8: wedge-final 走过 moveAway 8b — 顺坡白得的 y 差不是"下降进度", 抬高下降门槛到 >=3
    // (moveAway 顺坡至多白得 1-2 格; 真挖降 3+ 格再楔死的派发不该被一票否决白吃 strike),
    // 否则 moveAway 下坡 1 格就把三连楔死洗成 truthy = 新活锁口.
    const progressed = wedgeFinal
        ? (entryY - r.endY) >= 3 || oreUnits() > oreUnitsAtEntry
        : (entryY - r.endY) >= 1 || oreUnits() > oreUnitsAtEntry;
    if (!progressed) r.failed = true;
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { stairCells, stairSafety };
