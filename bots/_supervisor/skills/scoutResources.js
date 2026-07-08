// scoutResources — OPENING SCOUT: find the first tree (wood) and/or the nearest village so the
// bootstrap chain (wood→table→pickaxe / village beds+crops) can begin. This is the daytime answer
// to the "naked spawn sleepwalks into a generic prepNether" failure: instead of wandering, the bot
// does a deliberate, BOUNDED radial search for the two resources that unlock the early game.
//
// WHY THIS EXISTS (framework-v2 opening spec): computeOpening (modes.js) classifies the opening into
//   SCOUT / WOOD_BUFFER / VILLAGE_HARVEST / DONE with need = wood | village | both | null.
//   The SCOUT state proposes OPENING_SCOUT(skill=scoutResources). This skill TURNS that intent into
//   movement: it walks toward known/visible wood and/or hop-marches a bounded radial pattern probing
//   for a village, letting the C328 landmark scanner (modes.js) auto-PERSIST whatever it loads into
//   range. This skill itself never writes landmarks.json — it only MOVES so the scanner can see.
//
// HARD SAFETY (the explore-and-die lesson): defer to the survival layer on night / hp<=6 / a close
//   actionable hostile. Movement is short hops the planner can solve; the self_preservation reflex
//   (modes.js) runs throughout goToPosition. Only when WE actively move do we clear a stale MAROONED
//   flag (same authority-take as forageExplore/migrate) so a dead flag can't silently no-op every hop.
//
// opts: { need, hop=8, maxBlocks=64, treeDist=24, treeDy=6 }
//   need overrides bot._world.opening.need (default 'both').
//
// ctx = { log, skills, world, mc, Vec3 }
// returns { scouted:true, need, treeCost, villageCost, best, pursued, reason? } on REAL progress
// (net travel / new landmark); { scouted:false, failed:true, reason } on zero-progress runs and on
// the low-hp / hostile-close defers, so the kernel dispatch-cooldown can trip (kernel contract).

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const VILLAGE_BLOCKS = ['bell', 'hay_block', 'farmland', 'composter'];
const NIGHT_START = 13000, NIGHT_END = 23000;

// PURE — pick which resource to chase when need='both'/null: the nearer cost wins. A null cost means
// "not found"; if both are null nothing is pursued. PURE so it's offline-testable.
function chooseTarget(need, treeCost, villageCost) {
    const n = need || 'both';
    if (n === 'wood') return treeCost != null ? 'wood' : null;
    if (n === 'village') return villageCost != null ? 'village' : null;
    // both / null → nearer of the two known costs
    if (treeCost == null && villageCost == null) return null;
    if (treeCost == null) return 'village';
    if (villageCost == null) return 'wood';
    return treeCost <= villageCost ? 'wood' : 'village';
}

export default async function scoutResources(bot, ctx, opts = {}) {
    const { log, skills, world, mc } = ctx;
    const log_ = (m) => log(bot, `[scoutResources] ${m}`);

    // ★2026-07-09 GHOST-STACK 快速退出 ([[ghost-stack-epoch-poison]], 与 chopWood 同款): 重连毒化尸体
    //   (agent._poisonDeadBot) 后, 幽灵 kernel 仍在【死 bot】上反复派 scoutResources —— 每次 goToPosition
    //   撞 STALE-BOT throw 却照样刷 "pursue village @-75,117" 污染监工、假装乱逛 (实录 18:31-18:37 刷了 5min+)。
    //   认 bot._poisoned (毒化时一次性置真、幽灵清不掉的【跨实例】信号), 进门即退, 幽灵派发退化成空转 cooldown。
    //   活 bot 永不置真, 零影响。
    const _stale = () => { try { return !!bot._poisoned; } catch (e) { return false; } };
    if (_stale()) { log_('STALE-BOT — 幽灵在死实例上派发, 立即退出 (ghost-stack fast-exit)'); return { scouted: false, failed: true, reason: 'stale-bot-ghost' }; }

    // ★2026-07-09 用户令 HP/食物本能熔断: 低血本能默认熔断 (MC_HP_INSTINCTS!=='1' → 不因低血让位/中止侦察); 闸开恢复原行为。
    const _hpOn = () => process.env.MC_HP_INSTINCTS === '1';

    const HOP = opts.hop || 8;
    const maxBlocks = opts.maxBlocks || 64;
    // ★2026-07-09 用户令 "从96探起": 开局侦查本地感知太短 (旧 24/32b) → 出生点 30-90b 有树也看不见,
    //   pursued 保持空 → 掉到 oracle/放射漫游 = "开局还在侦查瞎转"。放大到 96b, 让近-中距真树直接被
    //   findTree 命中 → chooseTarget=wood → 直接定向寻路 (可跨水), 从根上砍掉无目标的 hop-march 漫游。
    const treeDist = opts.treeDist ?? 96;
    // ★配套 "从96探起": 96b 外地形起伏常 >6, 死守 treeDy=6 会把远处真树又滤掉 → 横向放大失效。
    //   放宽到 16 (仍拒真陡崖顶树, 保 C324 可达性教训), 与 treeDist=96 配平。
    const treeDy = opts.treeDy ?? 16;

    const isNight = () => { try { const t = bot.time.timeOfDay; return t > NIGHT_START && t < NIGHT_END; } catch { return false; } };
    const closeActionable = () => {
        try {
            return Object.values(bot.entities || {}).some(e =>
                e && e !== bot.entity && e.position && mc.isHostile(e)
                && e.position.distanceTo(bot.entity.position) < 6);
        } catch { return false; }
    };

    // ── HARD SURVIVAL GATE: scouting is a healthy-daylight activity; hand night / low-hp / point-blank
    //    hostile to the survival layer rather than walk out into a deadly window. ──
    // ★kernel return contract (audit 2026-07-02): the low-hp and hostile-close defers were truthy
    //   ({deferred:true}) — kernel-success, strike counter reset — but NOTHING dethrones the committed
    //   OPENING_SCOUT in those states: the proposal gate has no hp term, isGoalDone needs BOTH
    //   lm.wood && lm.village (never true for a bare bot), HOLD@95 needs actionable>0 && hp<10, and
    //   GET_FOOD's emergency needs food<=4 — so a hp<=6 bot (or one with a sealed/unreachable hostile
    //   <6b that never engages) re-dispatched this instant no-op every ~2s ALL DAY (same family as the
    //   craftChain/feedUp/migrate livelocks). failed:true lets 3 strikes trip the kernel's 5-min
    //   dispatch-cooldown, releasing the body to GET_FOOD@88/BOOTSTRAP_KIT@90/combat while the blocker
    //   persists. NIGHT stays a truthy defer BY DESIGN: at night the SCOUT proposal isn't pushed, so
    //   commitGoal's livePri falls to 50 and any night plan @91+ provably dethrones — it cannot loop.
    if (isNight()) { log_('defer: night — shelter, do not scout'); return { scouted: false, deferred: true, reason: 'night' }; }
    // ★2026-07-09 用户令 HP/食物本能熔断: 低血侦察让位 (pure hp, 无威胁) — HP 闸开才生效; 闸关时不因低血 defer。
    if (_hpOn() && Math.round(bot.health) <= 6) { log_(`defer: hp=${Math.round(bot.health)}<=6 — too fragile to scout`); return { scouted: false, failed: true, reason: 'low-hp' }; }
    if (closeActionable()) { log_('defer: actionable hostile close — handle threat first'); return { scouted: false, failed: true, reason: 'hostile-close' }; }

    const need = opts.need || (bot._world && bot._world.opening && bot._world.opening.need) || 'both';
    const start = bot.entity.position.clone();
    // Entry landmark snapshot — "a NEW landmark appeared during this run" counts as progress for the
    // kernel return contract even when net travel was short (audit 2026-07-02).
    const lm0 = (bot._world && bot._world.landmarks) || {};
    const hadWood = !!lm0.wood, hadVillage = !!lm0.village;
    log_(`★SCOUT need=${need} @${Math.round(start.x)},${Math.round(start.z)} maxBlocks=${maxBlocks}`);

    // We are the deliberate mover — clear a stale MAROONED flag so goToPosition isn't silently
    // suppressed (same authority-take as forageExplore/migrate).
    const takeMovement = () => { try { if (bot._mobility && bot._mobility.state === 'MAROONED') { bot._mobility.state = 'FREE'; log_('cleared MAROONED — scout owns movement'); } } catch (e) {} };

    // ── TREE COST: nearest reachable log via the world primitive (no re-implementing search). Relax to
    //    dist<=treeDist & |dy|<=treeDy so a steep plateau log isn't counted (C324 reachability lesson). ──
    // ★2026-07-09 socket-drop 根因修 (用户令 A): 旧代码单发同步 world.getNearestBlocks(…,96,24) —
    //   无树开局地形凑不满 count → findBlocks 扫满整个 96³ 体积, 同步冻结事件循环 15–24s → bot 停读 MC
    //   socket → socketClosed → 重连循环 (实录每次掉线紧跟一次 act=scout/chopWood 的 15–24s ELOOP 冻结)。
    //   改分级扫描: 32b 同步 (近树最常见, 零 async 开销秒回) → 都没有才 48b/96b, 每级前 setImmediate 让路
    //   把 MC socket 读放行, 96b 走 world.getNearestBlocksAsync 的 expanding-shell (64→96 间自带 yield)。
    //   命中即返回 → 常见地形永不走到 96b 大扫描。treeDist/treeDy 语义不变。
    const _pickTree = (logs) => {
        const by = start.y;
        for (const lp of (logs || [])) {
            const pos = (lp && lp.position) ? lp.position : lp;
            if (!pos) continue;
            const d = Math.hypot(pos.x - start.x, pos.z - start.z);
            if (d <= treeDist && Math.abs(pos.y - by) <= treeDy) {
                return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), cost: +d.toFixed(1) };
            }
        }
        return null;
    };
    const _yieldEL = () => new Promise((r) => setImmediate(r));
    const findTree = async () => {
        try {
            // stage 1 — 32b 同步: 体积小(~1MB blocks), 近树秒回, 不付 async 税
            let hit = _pickTree(world.getNearestBlocks(bot, LOG_TYPES, 32, 24));
            if (hit) return hit;
            // stage 2 — 48b: 先让路(放行 socket 读)再扫
            await _yieldEL();
            hit = _pickTree(await world.getNearestBlocksAsync(bot, LOG_TYPES, 48, 24));
            if (hit) return hit;
            // stage 3 — 96b: 再让路 + expanding-shell 异步版 (shell 间 yield, 不整块冻死)
            await _yieldEL();
            hit = _pickTree(await world.getNearestBlocksAsync(bot, LOG_TYPES, 96, 24));
            if (hit) return hit;
        } catch (e) { log_(`findTree err: ${e && e.message || e}`); }
        return null;
    };

    // ── VILLAGE COST: prefer the C328 landmark memory (persisted village), else live-sense a villager
    //    entity or a village-tell block in range. Returns {x,y,z,cost} or null. ──
    const knownVillage = () => { try { const v = bot._world && bot._world.landmarks && bot._world.landmarks.village; if (v && Number.isFinite(v.x)) return { x: v.x, y: v.y, z: v.z, cost: +Math.hypot(v.x - bot.entity.position.x, v.z - bot.entity.position.z).toFixed(1) }; } catch (e) {} return null; };
    const senseVillage = () => {
        const p = bot.entity.position;
        // villager entity
        try {
            let best = null, bd = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (e && e.position && /villager/.test((e.name || '').toLowerCase())) {
                    const d = e.position.distanceTo(p);
                    if (d < bd) { bd = d; best = e.position; }
                }
            }
            if (best) return { x: Math.round(best.x), y: Math.round(best.y), z: Math.round(best.z), cost: +bd.toFixed(1) };
        } catch (e) {}
        // village-tell block (bell/hay/farmland/composter)
        try {
            const blks = world.getNearestBlocks(bot, VILLAGE_BLOCKS, 48, 1) || [];
            if (blks.length) {
                const pos = blks[0].position || blks[0];
                return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), cost: +Math.hypot(pos.x - p.x, pos.z - p.z).toFixed(1) };
            }
        } catch (e) {}
        return null;
    };

    // ── SEA GUARD (2026-07-08): the hop-march below picks a random bearing and marched straight into
    //    the ocean — bare coastal spawns "往海边跑" then the in-water get-out reflex fights it → the
    //    dumb shore oscillation. Reject a hop whose destination column is DEEP water (≥2 deep = real
    //    ocean, not a 1-deep puddle/river ford) so the sweep rotates to a land bearing. If every ray is
    //    sea (islet), turnIdx exhausts → zero-progress failed → kernel cooldown → MIGRATE/woodBarren
    //    escape (the correct answer for a boxed-in coastal spawn). ──
    const Vec3 = ctx.Vec3 || bot.entity.position.constructor;
    const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
    const destIsDeepWater = (x, z) => {
        try {
            // scan around the bot's CURRENT elevation (not entry start.y — it drifts as we hop up/down;
            // anchoring on stale start.y would probe caves/air after a climb). Widen the window a bit.
            const refY = Math.round(bot.entity.position.y);
            for (let dy = 3; dy >= -4; dy--) {
                const b = bot.blockAt(new Vec3(x, refY + dy, z));
                if (!b || isAir(b.name)) continue;
                if (b.name !== 'water') return false;               // land/solid surface → fine
                const below = bot.blockAt(new Vec3(x, refY + dy - 1, z));
                return !!(below && below.name === 'water');         // ≥2 water deep → ocean, avoid
            }
        } catch (e) {}
        return false;   // unknown/unloaded → don't over-avoid
    };

    // Initial costs from where we stand.
    let tree = (need === 'village') ? null : await findTree();
    let village = (need === 'wood') ? null : (knownVillage() || senseVillage());
    let treeCost = tree ? tree.cost : null;
    let villageCost = village ? village.cost : null;
    let pursued = null;
    let best = null;

    // ── If we already have a target in range, pursue the nearer one directly (C328 scanner falls the
    //    landmark as we approach; we don't write landmarks.json here). ──
    const goTo = async (t, label) => {
        if (!t) return false;
        if (_stale()) return false;   // ★ghost-stack: 别在死 bot 上寻路 + 刷 pursue 日志
        takeMovement();
        log_(`pursue ${label} @${t.x},${t.z} (cost=${t.cost})`);
        try { await skills.goToPosition(bot, t.x, Math.round(bot.entity.position.y), t.z, 2); }
        catch (e) { log_(`${label} nav err: ${e && e.message || e}`); }
        return true;
    };

    const direct = chooseTarget(need, treeCost, villageCost);
    if (direct === 'wood') { pursued = 'wood'; best = tree; await goTo(tree, 'wood'); }
    else if (direct === 'village') { pursued = 'village'; best = village; await goTo(village, 'village'); }

    // ── ORACLE BEACON (2026-07-08 用户令 "优先寻路、超范围才 oracle"): 本地感知 (findTree 32b /
    //    senseVillage 48b) 是"优先寻路"层 — 见得到就直接寻路过去 (上面 direct)。若近处一无所获, 别急着
    //    盲扫 —— ore-oracle 已离线扫过 region 的 wood(树根,去重) / village(bell/composter/hay 指示物)
    //    坐标。取最近的当"超范围灯塔", 直接 goToPosition 定向寻路过去, 取代随机 land-bias radial sweep
    //    (它在海岸出生点常年贴海磨蹭)。灯塔可能数百格远 → 一次 goToPosition 走 partial, 下一拍续走,
    //    净位移即算 kernel 进度; 真够不到(孤岛)则 movedNet<12 → failed → cooldown → MIGRATE 逃生 (正解)。
    if (!pursued) {
        const oracleNearest = (arr) => {
            try {
                if (!Array.isArray(arr) || !arr.length) return null;
                const p = bot.entity.position;
                let bestC = null, bd = Infinity;
                for (const c of arr) {
                    if (!c || !Number.isFinite(c.x)) continue;
                    const d = Math.hypot(c.x - p.x, c.z - p.z);
                    if (d < bd) { bd = d; bestC = c; }
                }
                return bestC ? { x: bestC.x, y: bestC.y, z: bestC.z, cost: +bd.toFixed(1) } : null;
            } catch (e) { return null; }
        };
        const oo = bot._world && bot._world.oracleOres;
        const oTree = (need !== 'village') ? oracleNearest(oo && oo.wood) : null;
        const oVillage = (need !== 'wood') ? oracleNearest(oo && oo.village) : null;
        const oPick = chooseTarget(need, oTree ? oTree.cost : null, oVillage ? oVillage.cost : null);
        if (oPick === 'wood') {
            pursued = 'oracle-wood'; best = oTree; treeCost = oTree.cost;
            log_(`oracle beacon → wood root @${oTree.x},${oTree.y},${oTree.z} (${oTree.cost}b, 超本地感知 → 定向寻路)`);
            await goTo(oTree, 'oracle-wood');
        } else if (oPick === 'village') {
            pursued = 'oracle-village'; best = oVillage; villageCost = oVillage.cost;
            log_(`oracle beacon → village @${oVillage.x},${oVillage.y},${oVillage.z} (${oVillage.cost}b → 定向寻路)`);
            await goTo(oVillage, 'oracle-village');
        }
    }

    // ── BOUNDED RADIAL HOP-MARCH: nothing known in range → probe outward to LOAD chunks so the C328
    //    scanner (and our own sense) can find resources. Turn through a fan so we sweep an arc, not a
    //    single ray. Re-check survival each hop; re-sample tree/village after each hop. ──
    if (!pursued && (need !== 'wood' || treeCost == null) && (need !== 'village' || villageCost == null)) {
        const TURNS = [0, 45, -45, 90, -90, 135, -135, 180];
        let turnIdx = 0;
        let adv = 0;
        // ★LAND-BIAS 初始选向 (2026-07-08 用户令): 旧版 baseAng 纯随机 — 海岸出生点随机方位常年指海,
        //   而 sea-guard 只在"下一格恰好是深水"时才被动转向, 于是贴着海岸磨、从不主动转内陆 (新世界实证:
        //   出生点正南 80b 有树, 随机方位却指西南海 → 净漂移进水里, nearest=NONE)。开跑前先采样 8 个方位、
        //   每个沿射线探 4 格深水, 直接从"最内陆(深水命中最少)"的方位起步; 平手用随机起始序破(保留每轮变化)。
        const baseAng = (() => {
            const cx = bot.entity.position.x, cz = bot.entity.position.z;
            let bestAng = Math.random() * Math.PI * 2, bestWater = 99;
            const off = Math.floor(Math.random() * 8);   // 随机起始序 → 全内陆(平手)时仍每轮换向
            for (let k = 0; k < 8; k++) {
                const a = (((k + off) % 8) * Math.PI) / 4;
                const ux = Math.cos(a), uz = Math.sin(a);
                let water = 0;
                for (let r = 1; r <= 4; r++) {
                    if (destIsDeepWater(Math.round(cx + ux * HOP * r), Math.round(cz + uz * HOP * r))) water++;
                }
                if (water < bestWater) { bestWater = water; bestAng = a; }
            }
            log_(`land-bias baseAng=${Math.round((bestAng * 180) / Math.PI)}° water=${bestWater}/4`);
            return bestAng;
        })();
        const dir = (deg) => { const a = baseAng + (deg * Math.PI) / 180; return { x: Math.cos(a), z: Math.sin(a) }; };

        for (let hop = 1; adv < maxBlocks && turnIdx < TURNS.length; hop++) {
            if (bot.interrupt_code || _stale()) { log_(`interrupted at hop ${hop}${_stale() ? ' (STALE-BOT ghost-exit)' : ''}`); break; }
            if (isNight()) { log_(`night fell at hop ${hop} — abort scout`); break; }
            if (closeActionable()) { log_(`hostile close at hop ${hop} — abort scout`); break; }
            // ★2026-07-09 用户令 HP/食物本能熔断: 中途低血中止侦察 (pure hp, 无威胁) — HP 闸开才生效; 闸关不中止。
            if (_hpOn() && Math.round(bot.health) <= 6) { log_(`hp dropped <=6 at hop ${hop} — abort scout`); break; }

            // re-sense from new vantage (chunks loaded)
            if (need !== 'village' && treeCost == null) { const t = await findTree(); if (t) { tree = t; treeCost = t.cost; } }
            if (need !== 'wood' && villageCost == null) { const v = knownVillage() || senseVillage(); if (v) { village = v; villageCost = v.cost; } }
            const pick = chooseTarget(need, treeCost, villageCost);
            if (pick === 'wood') { pursued = 'wood'; best = tree; await goTo(tree, 'wood'); break; }
            if (pick === 'village') { pursued = 'village'; best = village; await goTo(village, 'village'); break; }

            // advance one hop along the current sweep ray
            takeMovement();
            const d = dir(TURNS[turnIdx]);
            const hx = Math.round(bot.entity.position.x + d.x * HOP);
            const hz = Math.round(bot.entity.position.z + d.z * HOP);
            // ★sea guard: don't march into the ocean — rotate to a land bearing instead.
            if (destIsDeepWater(hx, hz)) {
                turnIdx++;
                if (turnIdx < TURNS.length) log_(`hop ${hop} → deep water @${hx},${hz} — turn ${TURNS[turnIdx]}° (avoid sea)`);
                else log_(`hop ${hop} → all rays sea-blocked — end march (coastal barren → escape)`);
                continue;
            }
            const before = bot.entity.position.clone();
            try { await skills.goToPosition(bot, hx, Math.round(bot.entity.position.y), hz, 2); }
            catch (e) { /* PathfindingNoPlan — treated as a stalled hop below */ }
            const moved = bot.entity.position.distanceTo(before);
            adv += moved;
            if (moved < HOP * 0.4) {
                // stalled this ray → rotate the sweep
                turnIdx++;
                if (turnIdx < TURNS.length) log_(`hop ${hop} stalled (moved ${moved.toFixed(0)}b) — turn ${TURNS[turnIdx]}°`);
            }
        }
        log_(`hop-march done adv=${Math.round(adv)}b pursued=${pursued || 'none'}`);
    }

    // ★kernel return contract (audit 2026-07-02): this tail was UNCONDITIONALLY scouted:true — a
    // boxed-in bot (all 8 sweep rays NoPath'd, moved≈0, nothing found) or an unreachable pursued
    // target (goTo swallows nav errors; the same tree across a ravine re-picked every run) returned
    // kernel-success forever, resetting the strike counter so the 3-strike/5-min cooldown never
    // tripped while isGoalDone (lm.wood && lm.village) kept OPENING_SCOUT committed — an unbreakable
    // ~2s hot livelock that also starved the MIGRATE/woodBarren escape (it only runs once the
    // cooldown suppresses this kind) and re-cleared MAROONED via takeMovement() each pass, resetting
    // the mobility system's own escalation. Truthy now REQUIRES real progress this dispatch: genuine
    // travel (net displacement >= 12b ≈ 1.5 hops) or a NEW landmark the C328 scanner persisted
    // during the run. Zero-progress runs return failed:true so the kernel cooldown engages.
    const lmNow = (bot._world && bot._world.landmarks) || {};
    const newLandmark = (!hadWood && !!lmNow.wood) || (!hadVillage && !!lmNow.village);
    const movedNet = bot.entity.position.distanceTo(start);
    if (!newLandmark && movedNet < 12) {
        log_(`zero-progress run (moved=${Math.round(movedNet)}b, pursued=${pursued || 'none'}, no new landmark) → failed for kernel cooldown`);
        return { scouted: false, failed: true, need, treeCost, villageCost, pursued,
                 reason: 'zero-progress: no movement and no new landmark (boxed in / target unreachable)' };
    }
    const r = {
        scouted: true,
        need,
        treeCost,
        villageCost,
        best: best ? { x: best.x, y: best.y, z: best.z, cost: best.cost } : null,
        pursued,
        reason: pursued ? `pursued ${pursued}` : 'no wood/village found within scout range',
    };
    log_(`DONE ${JSON.stringify(r)}`);
    return r;
}

export { scoutResources, chooseTarget };
