// Hot-reloadable STRATEGY skill: establish a HOME RESPAWN by placing a bed and
// activating it. This is the strategic fix for the night-water-spawn death loop —
// in modern MC (1.21) right-clicking a bed sets your respawn point ANY time of day
// ("Respawn point set"), so once we plant a bed at our base, deaths stop dumping us
// back at the brutal water-edge spawn. If it's night AND safe, we also sleep to skip
// the night entirely (and top off the spawn). Self-bootstrapping: if we have no bed
// we try to craft one (3 wool + 3 planks); if we have no wool we hunt a nearby sheep.
//
// Trigger conditions (decided by the caller — prepNether runs it early, and a modes.js
// instinct can fire it at dusk): invoke once we have basic capability so the FIRST
// daylight grind plants a home bed and permanently escapes the spawn trap.
// Invoked via: {"skill":"setBed"}  or  customSkill(bot,'setBed')
// ctx = { skills, world, mc, Vec3, log }
import fs from 'fs';
import path from 'path';
const PROG = path.resolve(process.cwd(), 'bots', '_supervisor', 'progress.txt');
const BEDF = path.resolve(process.cwd(), 'bots', '_supervisor', 'bed.json');
const prog = (s) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };

export default async function setBed(bot, ctx) {
    const { skills, world, Vec3, log } = ctx;
    const inv = () => world.getInventoryCounts(bot);
    const countMatch = (re) => { const c = inv(); return Object.keys(c).filter(n => re.test(n)).reduce((s, n) => s + c[n], 0); };
    const firstMatch = (re) => { const c = inv(); return Object.keys(c).find(n => re.test(n) && c[n] > 0); };
    const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|drowned|husk|stray|phantom|slime|piglin|silverfish|cave_spider|pillager|vindicator/i;
    const hostilesNear = (r = 8) => Object.values(bot.entities).filter(e => e && e.position && e.name && HOSTILE.test(e.name) && e.position.distanceTo(bot.entity.position) < r).length;
    const isNight = () => { try { const t = bot.time.timeOfDay; return t >= 12800 && t <= 23000; } catch (e) { return false; } };

    prog(`==== setBed START | beds=${countMatch(/_bed$/)} wool=${countMatch(/_wool$/)} ====`);

    // ---- 0. 自主选家 (人类逻辑编码,非监工手动接管) -------------------------------------
    // 人类怎么决定家在哪/要不要搬: ①"我老死在这片"→搬(用自己的death_log聚类觉察)
    // ②选址: 不在死亡聚集区 + 附近有树(木补给) ③锚定后床/箱随后建于此。
    // 无锚 或 现锚24格内有3+死亡(家成了凶宅) → 评估周边采样点,自主改锚。
    try {
        const DLF = path.resolve(process.cwd(), 'bots', '_supervisor', 'death_log.jsonl');
        const deaths = (() => {
            try {
                return fs.readFileSync(DLF, 'utf8').trim().split('\n').slice(-60)
                    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
                    .filter(r => r && typeof r.x === 'number');
            } catch (e) { return []; }
        })();
        const deathsNear = (x, z, r) => deaths.filter(d => Math.hypot(d.x - x, d.z - z) < r).length;
        let anchor = null; try { anchor = JSON.parse(fs.readFileSync(BEDF, 'utf8')); } catch (e) {}
        // anchorBad 两档: ①家门口凶宅(24格内3死) ②区域饱和(40格内8死 — 整个家域被死亡
        // 热图锁死,避区撤退无处可去,采集全被过滤,bot原地空转的温和死锁) → 远环搬家。
        const anchorBad = !anchor || typeof anchor.x !== 'number'
            || deathsNear(anchor.x, anchor.z, 24) >= 3
            || deathsNear(anchor.x, anchor.z, 40) >= 8;
        if (anchorBad) {
            const me = bot.entity.position;
            const cands = [[me.x, me.z]];
            // 近环40 + 远环100/150 (区域性绞肉机的出路: 整个出生区是160格直径死亡场,
            // 40格内挪窝跳不出去。远环候选 deathsNear=0、树未知=0分,本地一旦血流成河
            // (每死-10分)远方净土自然胜出 → 锚一挪,缰绳+硬回拉既有机制自动执行搬家远征)
            for (const rr of [40, 100, 150]) {
                for (let a = 0; a < 8; a++) cands.push([me.x + Math.cos(a * Math.PI / 4) * rr, me.z + Math.sin(a * Math.PI / 4) * rr]);
            }
            if (anchor && typeof anchor.x === 'number') cands.push([anchor.x, anchor.z]);   // 老家也参评
            let logsPos = [];
            try {
                for (const ln of ['oak_log', 'birch_log', 'spruce_log', 'jungle_log']) {
                    const bdef = bot.registry.blocksByName[ln];
                    if (bdef) logsPos.push(...((await world.getNearestBlocksAsync(bot, ln, 64, 40)) || []).map(b => b.position));
                }
            } catch (e) {}
            // ★C322-A (T-0059, 用户实证 lake-edge 死循环 deaths 0→1→2): 旧选址只 -deathsNear*10+trees,
            // 完全不避水 → 选了湖边(树多+死少但在水边)→ 反复溺水+封顶失败(水边无干井位)死循环。加避水:
            // 候选 6b 内有水重罚 -100,绝不在湖/河边安家。findBlocks 只覆盖加载区,远候选水探不到=尽力而为,
            // 但近湖边候选(已加载)必被否,把床推向干地→溺水+封顶失败两大死因从根消除。
            let waterPos = [];
            try { const wdef = bot.registry.blocksByName['water']; if (wdef) waterPos = ((await world.getNearestBlocksAsync(bot, 'water', 64, 300)) || []).map(b => b.position); } catch (e) {}
            let best = null, bestScore = -1e9;
            for (const [cx, cz] of cands) {
                const dn = deathsNear(cx, cz, 24);
                const trees = logsPos.filter(p => Math.hypot(p.x - cx, p.z - cz) < 24).length;
                const waterNear = waterPos.filter(p => Math.hypot(p.x - cx, p.z - cz) < 6).length;
                const score = -dn * 10 + Math.min(trees, 6) - (waterNear > 0 ? 100 : 0);   // ★避水: 6b内有水重罚,绝不湖边安家
                if (score > bestScore) { bestScore = score; best = { cx, cz, dn, trees, water: waterNear }; }
            }
            if (best) {
                const hy = Math.max(60, Math.min(95, Math.floor(me.y)));
                // ★P0-2 幻影家根修 (2026-07-04 取证: bed.json 曾被选址/migrate 写到 141,62,119 等
                // 从未放过床的点 → bankGear/chopWood/prepNether/modes 缰绳全锚在幻影上)。选址结果
                // 只进内存 (bot._bedSitePick, 供选址消费方参考) + 日志; bed.json 从此只在"床真实
                // 放置 + activate spawn set 成功"之后落盘 (本文件末尾唯一写点)。
                try { bot._bedSitePick = { x: Math.round(best.cx), y: hy, z: Math.round(best.cz), t: Date.now(), deathsNear: best.dn, trees: best.trees }; } catch (e) {}
                prog(`setBed: ★自主选家(仅内存) @${Math.round(best.cx)},${Math.round(best.cz)} (死亡密度${best.dn} 树${best.trees}) — bed.json 延迟到真实放床+锚定成功后再写`);
            }
        }
    } catch (e) { prog(`setBed: home-select err ${e.message}`); }

    // ★同色羊毛口径 (P0-2 取证 2026-07-04T04:38 实锤: wool=6 仍 "You do not have the resources
    // to craft a black_bed. It requires: black_wool: 3" — 床配方要 3 张【同色】羊毛,
    // countMatch(/_wool$/) 混色计总数=幻觉充足, firstMatch 还会随机挑中只有 1-2 张的颜色。
    // 07-03T16:12 起 12h+ 里 bot 一直攒着 ≥3 张混色羊毛做不出床 → 夜链断死的直接根因之一。
    // 以下猎毛门/攒毛门/合成门全部换成"最多单色计数"。
    const woolBest = () => {
        const c = inv();
        let name = null, ct = 0;
        for (const n of Object.keys(c)) { if (/_wool$/.test(n) && c[n] > ct) { name = n; ct = c[n]; } }
        return { color: name ? name.replace(/_wool$/, '') : 'white', ct };
    };

    // ★现床直用 (activate 失败返 false 的下一轮: 床已放在世界里、不在背包 — 不查现床会又去
    // 猎羊做第二张床)。12b 内已有任意床 → 跳过获取/放置, 直接走激活锚定。
    let preBed = null;
    try { const _pb = await world.getNearestBlocksWhereAsync(bot, (b) => b && /_bed$/.test(b.name || ''), 12, 1); preBed = (_pb && _pb.length) ? _pb[0] : null; } catch (e) {}
    if (preBed) prog(`setBed: 12b 内已有现床 @${preBed.position.x},${preBed.position.y},${preBed.position.z} — 跳过获取/放置, 直接激活锚定`);

    // ---- 1. ACQUIRE A BED -------------------------------------------------------------
    let bedName = preBed ? null : firstMatch(/_bed$/);
    if (!bedName && !preBed) {
        // Don't chase sheep through a mob swarm — that just feeds the death loop. If it's
        // not safe to forage, defer (return false); the caller keeps grinding and retries
        // setBed next cycle once we're clear. (The run/bunker instinct handles the swarm.)
        // Need 3 wool + 3 planks. Wool is a MOB DROP (achieve can't resolve it). Two sources:
        //   (A) STRING→WOOL — 4 string = 1 white_wool (2x2, NO table). Spiders drop string,
        //       and in this jungle there are NO sheep but the night swarm is *full* of spiders.
        //       So we bootstrap a bed from the very mobs besieging us. By DAY spiders are
        //       passive → safe to pick off 1-by-1. This is the path that finally breaks the
        //       bedless-respawn death loop in a sheepless biome.
        //   (B) SHEEP — the classic path, used if any sheep are actually around.
        const tryCraftWool = async () => {
            // string→wool 产物固定是 white_wool → 缺口按 white 单色算 (混色总数凑 3 做不了床)
            const need = 3 - (inv().white_wool || 0);
            if (need <= 0 || woolBest().ct >= 3) return;
            const canMake = Math.min(need, Math.floor(countMatch(/^string$/) / 4));
            if (canMake > 0) { try { await skills.craftRecipe(bot, 'white_wool', canMake); } catch (e) { prog(`setBed: craft wool err ${e.message}`); } }
        };
        // (0) FREE WOOL: scoop up any string from spiders we already killed + craft it. No
        //     movement → always safe, even mid-swarm. Do this before deciding to defer.
        try { await skills.pickupNearbyItems(bot); } catch (e) {}
        await tryCraftWool();

        // (A) DAYLIGHT SPIDER-STRING HUNT. Gated on day + a CALM area (≤2 mobs within 6) so a
        //     night swarm that lingered into dawn can't lure us in. Re-checks night/interrupt
        //     each loop. Bounded 8 tries / 60s. String accumulates across setBed calls, so
        //     even a few per call converges on a bed over a couple daylight cycles.
        // ★ACTIVE daylight spider hunt for string→wool→bed (this jungle has NO sheep, so string
        // is the ONLY wool path; passively waiting for a spider within 24 never converged → bed
        // never got built → death-spiral root never fixed). SAFETY GATES (per用户"谨慎控制风险"):
        // only when DAY + area calm (≤2 mobs/6) + WE HAVE A SWORD (never hunt barehanded). Widen
        // scan to 48 and actively path to the spider (daylight spiders are passive — safe to pick
        // off with a sword). attackEntity has a 30s no-progress timeout so it can't hang.
        const _huntSword = firstMatch(/sword$/);
        // ★远征装备门: 床任务合法,但远征必须可生存 — 石剑以上+食≥8 才出门打猎。
        // 木剑期夜晚靠地堡扛(挖二封一已验证),床不急于一时。
        const _huntFit = _huntSword && !/wooden_sword/.test(_huntSword) && bot.food >= 8;
        // ★C226-B1: a naked respawn only ever holds a wooden_sword → the stone-sword gate
        // above is unreachable → it can NEVER hunt → no string/wool → no bed → it respawns
        // FOREVER at the bad spawn (C226 mechanism ④, the death-loop root). The 218/222
        // lesson behind the strict gate was about FAR under-equipped ventures, not adjacent kills:
        // a CLOSE passive target (daylight spider / sheep ≤12b) in a calm area is safe to
        // take with a wooden sword. Allow a SHORT-RANGE opportunistic hunt at a lower bar;
        // the strict gate still governs the 48/64b venture. _huntRange: 48 (strong-fit
        // venture) / 12 (wooden-sword opportunistic) / 0 (no sword → barehanded, skip).
        const _huntFitClose = _huntSword && bot.food >= 6;
        const _huntRange = _huntFit ? 48 : (_huntFitClose ? 12 : 0);
        if (woolBest().ct < 3 && !isNight() && hostilesNear(6) <= 2 && _huntRange > 0) {
            const startS = Date.now();
            for (let h = 0; h < 12 && woolBest().ct < 3 && (Date.now() - startS) < 90000; h++) {
                if (bot.interrupt_code) { prog('setBed: interrupted during spider hunt'); break; }
                if (isNight() || hostilesNear(6) > 4) { prog('setBed: dusk/swarm mid spider-hunt — stop'); break; }
                const spider = world.getNearbyEntities(bot, _huntRange).filter(e => e && /spider/i.test(e.name) && !/cave/i.test(e.name))
                    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (!spider) { prog(`setBed: no spider within ${_huntRange} (string=${countMatch(/^string$/)}, wool=${countMatch(/_wool$/)}, ${_huntFit ? 'venture' : 'close-only/wooden'})`); break; }
                try { await skills.equip(bot, _huntSword); } catch (e) {}
                try { await skills.attackEntity(bot, spider, true); } catch (e) { prog(`setBed: spider err ${e.message}`); }
                try { await skills.pickupNearbyItems(bot); } catch (e) {}
                await tryCraftWool();
            }
        } else if (woolBest().ct < 3 && !isNight() && !_huntSword) {
            prog('setBed: no sword — skip active spider hunt (avoid barehanded risk), defer');
        }

        // (B) SHEEP HUNT — ★直取羊毛 (2026-07-03 任务B: 10:22 失床后 4h beds=0 wool=0, 而村口
        //     反复扫到 sheep@33-40b — 旧门 `_huntRange > 0` 要求有剑, 裸奔=0 → 整段跳过;
        //     木剑档半径 12 又永远够不到 33-40b 的羊 → setBed 无限 defer, 床链断死)。
        //     羊是零反击的被动生物: 白天(日夜门沿用 (A) 的
        //     isNight) + 无敌对(敌对门沿用原 hostilesNear(10) defer) + food≥6 底线
        //     即可出手, 无剑也允许(拳头杀羊零风险只是慢, 有剑仍先装剑)。剪刀有则剪优先
        //     (可持续 1-3 毛/羊), 剪完必捡 — 剪下的毛是掉落物, 旧剪刀分支从不 pickup=白剪。
        if (woolBest().ct < 3 && !isNight()) {
            if (hostilesNear(10) > 0) { prog(`setBed: short wool + mobs=${hostilesNear(10)} — defer (have string=${countMatch(/^string$/)})`); return false; }
            const woolFit = bot.food >= 6;
            const _sheepRange = (_huntFit || woolFit) ? 64 : 12;   // 低食物时收缩到贴身
            const start = Date.now();
            for (let h = 0; h < 6 && woolBest().ct < 3 && (Date.now() - start) < 60000; h++) {
                if (bot.interrupt_code) { prog('setBed: interrupted during wool hunt'); break; }
                if (hostilesNear(10) > 0) { prog('setBed: mob appeared mid wool-hunt — abort, defer'); return false; }
                if (isNight()) { prog('setBed: night fell mid wool-hunt — abort, defer'); return false; }
                const sheep = world.getNearbyEntities(bot, _sheepRange).filter(e => e && e.name === 'sheep')
                    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (!sheep) { prog(`setBed: no sheep within ${_sheepRange} (wool=${countMatch(/_wool$/)}, string=${countMatch(/^string$/)}, fit=${woolFit ? 'wool' : (_huntFit ? 'venture' : 'close-only')}) — defer`); break; }
                const shears = firstMatch(/^shears$/);
                const woolBefore = countMatch(/_wool$/);
                try {
                    await skills.goToPosition(bot, sheep.position.x, sheep.position.y, sheep.position.z, 1);
                    if (shears) {
                        try { await skills.equip(bot, 'shears'); } catch (e) {}
                        try { await bot.activateEntity(sheep); } catch (e) {}
                        await skills.wait(bot, 600);
                        try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    }
                    if (countMatch(/_wool$/) <= woolBefore) {   // 没剪到(无剪刀/已剃) → 杀羊拾毛
                        if (_huntSword) { try { await skills.equip(bot, _huntSword); } catch (e) {} }
                        try { await skills.attackEntity(bot, sheep, true); } catch (e) {}
                        try { await skills.pickupNearbyItems(bot); } catch (e) {}
                    }
                    prog(`setBed: 直取羊毛 wool ${woolBefore}->${countMatch(/_wool$/)} (${shears ? 'shears-first' : 'kill'}, sheep@${Math.round(sheep.position.distanceTo(bot.entity.position))}b)`);
                } catch (e) { prog(`setBed: sheep err ${e.message}`); }
            }
        }
        const wb = woolBest();
        if (wb.ct >= 3) {
            // Match the bed color to the SAME-COLOR wool stack we actually have (firstMatch 会
            // 挑到不足 3 张的颜色 — 07-04T04:38 black_bed 失败实锤)。
            const color = wb.color;
            if (countMatch(/planks$/) < 3) { try { await skills.customSkill(bot, 'achieve', { item: 'oak_planks', count: 3 }); } catch (e) {} }
            try { await skills.craftRecipe(bot, `${color}_bed`, 1); } catch (e) { prog(`setBed: craft ${color}_bed err ${e.message}`); }
            bedName = firstMatch(/_bed$/);
            if (!bedName) prog(`setBed: craft ${color}_bed 未产出 (单色毛${wb.ct} planks=${countMatch(/planks$/)}) — 大概率缺 planks, defer 走补给`);
        } else if (countMatch(/_wool$/) >= 3) {
            prog(`setBed: wool 混色陷阱 — 总${countMatch(/_wool$/)} 张但最多单色仅 ${wb.ct} (${wb.color}), 床要 3 同色 → 继续攒 ${wb.color}`);
        }
    }
    if (!bedName && !preBed) { prog('setBed: no bed and could not make one — defer (caller continues)'); log(bot, 'No bed yet — will retry once I have wool.'); return false; }

    // ---- 2. PLACE THE BED on flat solid ground with headroom --------------------------
    // A bed occupies TWO horizontal cells. Find a spot: stand on solid ground, with the
    // cell in front + above both cells clear. Try a few footing directions.
    const placeBed = async () => {
        const base = bot.entity.position.floored();
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of dirs) {
            const footPos = base.offset(dx, 0, dz);                 // where bed foot goes
            const headPos = base.offset(dx * 2, 0, dz * 2);         // head extends further
            const groundFoot = bot.blockAt(footPos.offset(0, -1, 0));
            const groundHead = bot.blockAt(headPos.offset(0, -1, 0));
            const airFoot = bot.blockAt(footPos), airHead = bot.blockAt(headPos);
            const solid = (b) => b && b.boundingBox === 'block';
            const openish = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name.includes('grass') || b.name.includes('snow'));
            if (solid(groundFoot) && solid(groundHead) && openish(airFoot) && openish(airHead)) {
                try {
                    // Clear any grass occupying the cells, then place legit (dontCheat=true).
                    for (const cell of [footPos, headPos]) { const b = bot.blockAt(cell); if (b && b.name !== 'air' && b.name !== 'cave_air') { try { await bot.tool.equipForBlock(b); } catch (e) {} try { await bot.dig(b); } catch (e) {} } }
                    await skills.placeBlock(bot, bedName, footPos.x, footPos.y, footPos.z, 'bottom', true);
                    return true;
                } catch (e) { prog(`setBed: place err ${e.message}`); }
            }
        }
        // Fallback: generic nearby placement.
        try { return await skills.placeBlockNearby(bot, bedName); } catch (e) { prog(`setBed: placeNearby err ${e.message}`); return false; }
    };
    if (!preBed) await placeBed();

    // ---- 3. ACTIVATE to set spawn (+ sleep if night & safe) ---------------------------
    const bedBlock = preBed || bot.findBlock({ matching: (b) => b && b.name.includes('bed'), maxDistance: 6 });
    if (!bedBlock) { prog('setBed: placed but cannot locate bed block — abort'); return false; }
    try { await skills.goToPosition(bot, bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1); } catch (e) {}
    // activateBlock = right-click → "Respawn point set" (works day or night in 1.21).
    let spawnSet = false;
    try { await bot.activateBlock(bedBlock); spawnSet = true; } catch (e) { prog(`setBed: activate err ${e.message}`); }
    // ★P0-2 幻影家根修: bed.json 只在"床真实存在 + spawn 真锚定"后写 ({x,y,z,t} 无 src 字段
    // = world_model.bedKnown 认可的真床格式)。activate 失败 → 不写锚、不 return true —
    // 诚实 false 让 kernel 重试 (下轮开头的"现床直用"会跳过猎毛直接再激活这张床)。
    if (!spawnSet) {
        prog(`==== setBed FAIL | activate 失败 spawnSet=false bed@${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z} — 不写 bed.json, 返 false (床已在世界, 下轮直激活) ====`);
        return false;
    }
    // Persist home so other logic (corpseRun / future instincts) knows where base is.
    try { fs.writeFileSync(BEDF, JSON.stringify({ x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z, t: Date.now() })); } catch (e) {}
    // ★夜链闭环: bed landmark 立即登记 (不等 C328 12s 扫描) → bedAffordable→DUSK_GO_BED
    // 下个黄昏即可提案 (07-03T11:22 断链根修的 setBed 侧)。
    try {
        if (bot._landmarks && typeof bot._landmarks === 'object') {
            const _key = `bed@${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z}`;
            const _n = Date.now();
            if (!bot._landmarks[_key]) bot._landmarks[_key] = { kind: 'bed', x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z, ts: _n, seen: _n, meta: null };
            else bot._landmarks[_key].seen = _n;
            fs.writeFileSync(path.resolve(process.cwd(), 'bots', '_supervisor', 'landmarks.json'), JSON.stringify(bot._landmarks));
            prog(`setBed: bed landmark 已登记 @${_key} — 夜链 (bedAffordable→DUSK_GO_BED) 恢复可提案`);
        }
    } catch (e) {}
    // If it's night and no mobs around, actually sleep to skip the night.
    if (isNight() && hostilesNear(8) === 0) {
        try { await bot.sleep(bedBlock); prog('setBed: sleeping...'); for (let i = 0; i < 40 && bot.isSleeping; i++) await skills.wait(bot, 500); prog('setBed: woke up (morning)'); }
        catch (e) { prog(`setBed: sleep refused (${e.message}) — spawn still set`); }
    }
    prog(`==== setBed DONE | spawnSet=${spawnSet} bed@${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z} ====`);
    log(bot, `Home bed set — respawn point relocated to base.`);
    return true;
}
