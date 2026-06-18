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
                    if (bdef) logsPos.push(...(bot.findBlocks({ matching: bdef.id, maxDistance: 64, count: 40 }) || []));
                }
            } catch (e) {}
            let best = null, bestScore = -1e9;
            for (const [cx, cz] of cands) {
                const dn = deathsNear(cx, cz, 24);
                const trees = logsPos.filter(p => Math.hypot(p.x - cx, p.z - cz) < 24).length;
                const score = -dn * 10 + Math.min(trees, 6);   // 安全权重 >> 资源权重
                if (score > bestScore) { bestScore = score; best = { cx, cz, dn, trees }; }
            }
            if (best) {
                const hy = Math.max(60, Math.min(95, Math.floor(me.y)));
                fs.writeFileSync(BEDF, JSON.stringify({ x: Math.round(best.cx), y: hy, z: Math.round(best.cz), t: Date.now(), src: 'auto-site-select', deathsNear: best.dn, trees: best.trees }));
                prog(`setBed: ★自主选家 @${Math.round(best.cx)},${Math.round(best.cz)} (死亡密度${best.dn} 树${best.trees}) — 锚已自主更新,床建于此`);
            }
        }
    } catch (e) { prog(`setBed: home-select err ${e.message}`); }

    // ---- 1. ACQUIRE A BED -------------------------------------------------------------
    let bedName = firstMatch(/_bed$/);
    if (!bedName) {
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
            const need = 3 - countMatch(/_wool$/);
            if (need <= 0) return;
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
        // ★远征装备门 (deaths 218+222 同死远西猎场: 木剑+低血跑100格外猎羊/猎蛛,被当地蜘蛛
        // 1v1收割两次): 床任务合法,但远征必须可生存 — 石剑以上+血≥16+食≥8 才出门打猎。
        // 木剑期夜晚靠地堡扛(挖二封一已验证),床不急于一时。
        const _huntFit = _huntSword && !/wooden_sword/.test(_huntSword)
            && bot.health >= 16 && bot.food >= 8;
        // ★C226-B1: a naked respawn only ever holds a wooden_sword → the stone-sword gate
        // above is unreachable → it can NEVER hunt → no string/wool → no bed → it respawns
        // FOREVER at the bad spawn (C226 mechanism ④, the death-loop root). The 218/222
        // lesson behind the strict gate was about FAR low-hp ventures, not adjacent kills:
        // a CLOSE passive target (daylight spider / sheep ≤12b) in a calm area is safe to
        // take with a wooden sword. Allow a SHORT-RANGE opportunistic hunt at a lower bar;
        // the strict gate still governs the 48/64b venture. _huntRange: 48 (strong-fit
        // venture) / 12 (wooden-sword opportunistic) / 0 (no sword → barehanded, skip).
        const _huntFitClose = _huntSword && bot.health >= 10 && bot.food >= 6;
        const _huntRange = _huntFit ? 48 : (_huntFitClose ? 12 : 0);
        if (countMatch(/_wool$/) < 3 && !isNight() && hostilesNear(6) <= 2 && _huntRange > 0) {
            const startS = Date.now();
            for (let h = 0; h < 12 && countMatch(/_wool$/) < 3 && (Date.now() - startS) < 90000; h++) {
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
        } else if (countMatch(/_wool$/) < 3 && !isNight() && !_huntSword) {
            prog('setBed: no sword — skip active spider hunt (avoid barehanded risk), defer');
        }

        // (B) SHEEP HUNT — only if still short. Defers on ANY hostile (don't chase sheep
        //     through a swarm — that just feeds the death loop). Bounded tries / 60s cap.
        //     远征装备门同 (A): 羊在远西猎场(spawn西南150格),木剑低血跑那么远=送(218/222)。
        if (countMatch(/_wool$/) < 3 && _huntRange > 0) {
            if (hostilesNear(10) > 0) { prog(`setBed: short wool + mobs=${hostilesNear(10)} — defer (have string=${countMatch(/^string$/)})`); return false; }
            const start = Date.now();
            const _sheepRange = _huntFit ? 64 : _huntRange;   // C226-B1: wooden sword → only adjacent sheep
            for (let h = 0; h < 6 && countMatch(/_wool$/) < 3 && (Date.now() - start) < 60000; h++) {
                if (bot.interrupt_code) { prog('setBed: interrupted during wool hunt'); break; }
                if (hostilesNear(10) > 0) { prog('setBed: mob appeared mid wool-hunt — abort, defer'); return false; }
                const sheep = world.getNearbyEntities(bot, _sheepRange).filter(e => e && e.name === 'sheep')
                    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (!sheep) { prog('setBed: no sheep within 64 — relying on string path, defer'); break; }
                const shears = firstMatch(/^shears$/);
                try {
                    await skills.goToPosition(bot, sheep.position.x, sheep.position.y, sheep.position.z, 1);
                    if (shears) { try { await skills.equip(bot, 'shears'); } catch (e) {} try { await bot.activateEntity(sheep); } catch (e) {} await skills.wait(bot, 600); }
                    else { try { await skills.attackEntity(bot, sheep, true); } catch (e) {} await skills.pickupNearbyItems(bot); }
                } catch (e) { prog(`setBed: sheep err ${e.message}`); }
            }
        }
        if (countMatch(/_wool$/) >= 3) {
            // Match the bed color to the wool color we actually have.
            const woolItem = firstMatch(/_wool$/);            // e.g. white_wool
            const color = woolItem ? woolItem.replace(/_wool$/, '') : 'white';
            if (countMatch(/planks$/) < 3) { try { await skills.customSkill(bot, 'achieve', { item: 'oak_planks', count: 3 }); } catch (e) {} }
            try { await skills.craftRecipe(bot, `${color}_bed`, 1); } catch (e) { prog(`setBed: craft ${color}_bed err ${e.message}`); }
            bedName = firstMatch(/_bed$/);
        }
    }
    if (!bedName) { prog('setBed: no bed and could not make one — defer (caller continues)'); log(bot, 'No bed yet — will retry once I have wool.'); return false; }

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
    await placeBed();

    // ---- 3. ACTIVATE to set spawn (+ sleep if night & safe) ---------------------------
    const bedBlock = bot.findBlock({ matching: (b) => b && b.name.includes('bed'), maxDistance: 6 });
    if (!bedBlock) { prog('setBed: placed but cannot locate bed block — abort'); return false; }
    try { await skills.goToPosition(bot, bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1); } catch (e) {}
    // activateBlock = right-click → "Respawn point set" (works day or night in 1.21).
    let spawnSet = false;
    try { await bot.activateBlock(bedBlock); spawnSet = true; } catch (e) { prog(`setBed: activate err ${e.message}`); }
    // Persist home so other logic (corpseRun / future instincts) knows where base is.
    try { fs.writeFileSync(BEDF, JSON.stringify({ x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z, t: Date.now() })); } catch (e) {}
    // If it's night and no mobs around, actually sleep to skip the night.
    if (isNight() && hostilesNear(8) === 0) {
        try { await bot.sleep(bedBlock); prog('setBed: sleeping...'); for (let i = 0; i < 40 && bot.isSleeping; i++) await skills.wait(bot, 500); prog('setBed: woke up (morning)'); }
        catch (e) { prog(`setBed: sleep refused (${e.message}) — spawn still set`); }
    }
    prog(`==== setBed DONE | spawnSet=${spawnSet} bed@${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z} ====`);
    log(bot, `Home bed set — respawn point relocated to base.`);
    return true;
}
